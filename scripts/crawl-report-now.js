// Send the crawl coverage report on demand, against TODAY's live data — same
// per-city deals+events table the monthly crawl emails, with zero inserts (no
// crawl is run). Useful to (a) verify the email pipeline works now, and (b) get
// a current coverage snapshot any time. Sends to CRAWL_REPORT_EMAIL ||
// FOUNDER_EMAIL (needs RESEND_API_KEY).
//
// Usage: railway variables --json | node scripts/crawl-report-now.js
const { createClient } = require("@supabase/supabase-js");

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = ""; process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function main() {
  const stdinEnv = await readStdinEnv();
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "CRAWL_REPORT_EMAIL", "FOUNDER_EMAIL"]) {
    if (!process.env[k] && stdinEnv[k]) process.env[k] = stdinEnv[k];
  }
  // Require after env is set — monthlyCrawl pulls in the Supabase client, which
  // throws at import time if the env isn't present yet.
  const { buildCityStats, maybeEmailReport } = require("../src/jobs/monthlyCrawl");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const todayStr = new Date().toISOString().slice(0, 10);

  // Cities + their venue ids (paged past PostgREST's 1000-row cap).
  const cityVenueIds = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("venues").select("id, city").range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const v of data) { if (v.city) (cityVenueIds[v.city] ||= []).push(v.id); }
    if (data.length < 1000) break;
  }
  const cities = Object.keys(cityVenueIds);

  const cityStats = await buildCityStats(cities, cityVenueIds, [], todayStr);
  const totalD = cityStats.reduce((s, c) => s + c.totalDeals, 0);
  const totalE = cityStats.reduce((s, c) => s + c.totalEvents, 0);
  console.log(`Coverage across ${cities.length} cities: ${totalD} active deals, ${totalE} upcoming events.`);
  for (const c of cityStats) console.log(`  ${c.city}: ${c.totalDeals} deals, ${c.totalEvents} events`);

  await maybeEmailReport(todayStr + " (on-demand snapshot)", {
    citiesCrawled: cities.length, dealsInserted: 0, eventsInserted: 0, report: [], cityStats,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
