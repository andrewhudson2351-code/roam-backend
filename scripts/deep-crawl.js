// Deep (monthly-style) crawl for a targeted CLUSTER of venues — runs the SAME
// extraction the monthly cron does (future-dated JSON-LD events + strict
// happy-hour deals + specials sub-pages + a review report), but scoped and
// runnable on demand, with no once-a-month guard.
//
// STANDING RULE (see CLAUDE.md): whenever a new cluster of venues is imported,
// run this for that cluster IF the monthly crawl is 2+ weeks away. This script
// enforces that window itself: by default it SKIPS when the next monthly crawl
// (1st of next month, UTC) is under 14 days out — pass --force to override.
//
// Scope (combinable): --city "Myrtle Beach"  --neighborhood Belmont  --since 2026-08-09
// Usage:
//   railway variables --json | node scripts/deep-crawl.js --since 2026-08-09
//   railway variables --json | node scripts/deep-crawl.js --city "Myrtle Beach" --dry   (report, no email)
//   railway variables --json | node scripts/deep-crawl.js --since 2026-08-09 --force
const { createClient } = require("@supabase/supabase-js");

const argVal = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const CITY = argVal("--city");
const NEIGHBORHOOD = argVal("--neighborhood");
const SINCE = argVal("--since");
const DRY = process.argv.includes("--dry");
const FORCE = process.argv.includes("--force");
const REPORT_JSON = argVal("--report-json"); // dump review candidates to this file for curation

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = ""; process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

// Days until the next monthly crawl (00:00 UTC on the 1st of next month).
function daysUntilMonthlyCrawl() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.ceil((next - now) / 86400000);
}

async function main() {
  const stdinEnv = await readStdinEnv();
  for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "CRAWL_REPORT_EMAIL", "FOUNDER_EMAIL"]) {
    if (!process.env[k] && stdinEnv[k]) process.env[k] = stdinEnv[k];
  }
  if (!CITY && !NEIGHBORHOOD && !SINCE) throw new Error("scope required — pass at least one of --city / --neighborhood / --since");

  const dLeft = daysUntilMonthlyCrawl();
  if (dLeft < 14 && !FORCE) {
    console.log(`Next monthly crawl is only ${dLeft} day(s) away (< 14) — per the standing rule, skipping the on-demand deep crawl (the monthly run will cover this cluster). Pass --force to run anyway.`);
    return;
  }
  console.log(`Monthly crawl is ${dLeft} day(s) away — proceeding with the deep cluster crawl.`);

  // Require after env is set — monthlyCrawl pulls in the Supabase client at import.
  const { crawlVenueSet, buildCityStats, maybeEmailReport } = require("../src/jobs/monthlyCrawl");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const todayStr = new Date().toISOString().slice(0, 10);

  let q = supabase.from("venues").select("id, name, city, neighborhood, website").not("website", "is", null);
  if (CITY) q = q.eq("city", CITY);
  if (NEIGHBORHOOD) q = q.eq("neighborhood", NEIGHBORHOOD);
  if (SINCE) q = q.gte("created_at", SINCE);
  const { data: venues, error } = await q;
  if (error) throw new Error(error.message);
  const scope = [CITY && `city=${CITY}`, NEIGHBORHOOD && `neighborhood=${NEIGHBORHOOD}`, SINCE && `since=${SINCE}`].filter(Boolean).join(", ");
  console.log(`Deep crawl targeting ${venues.length} venue(s) [${scope}].`);
  if (!venues.length) return;

  // Crawl per city so the report shows accurate per-city inserts.
  const byCity = {};
  for (const v of venues) (byCity[v.city] ||= []).push(v);
  const report = [];
  const perCity = [];
  const cityVenueIds = {};
  let dealsInserted = 0, eventsInserted = 0;
  for (const [city, cvenues] of Object.entries(byCity)) {
    cityVenueIds[city] = cvenues.map((v) => v.id);
    const r = await crawlVenueSet(cvenues, { todayStr, report });
    perCity.push({ city, dealsInserted: r.dealsInserted, eventsInserted: r.eventsInserted });
    dealsInserted += r.dealsInserted; eventsInserted += r.eventsInserted;
    console.log(`  ${city}: +${r.dealsInserted} deals, +${r.eventsInserted} events (${cvenues.length} venues)`);
  }

  console.log(`\nDeep crawl done: +${dealsInserted} deals, +${eventsInserted} events across ${Object.keys(byCity).length} city bucket(s). ${report.length} review candidate(s).`);
  if (REPORT_JSON) {
    require("fs").writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    console.log(`Wrote ${report.length} review candidate(s) to ${REPORT_JSON}.`);
  }
  if (DRY) { console.log("--dry — no email sent."); return; }
  const cityStats = await buildCityStats(Object.keys(byCity), cityVenueIds, perCity, todayStr);
  await maybeEmailReport(`cluster deep-crawl ${todayStr} [${scope}]`, {
    citiesCrawled: Object.keys(byCity).length, dealsInserted, eventsInserted, report, cityStats,
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
