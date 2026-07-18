// Backfill venues.website via Places API (New) Place Details.
// Field mask websiteUri bills the Place Details Enterprise SKU (1,000 free
// events/month) — keep single-city runs to stay inside the free tier.
// Only processes venues with a google_place_id and NULL website; safe to re-run.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY.
// Missing env vars are read from a JSON object piped to stdin (railway variables --json).
//
// Usage:
//   railway variables --json | node scripts/backfill-websites.js --city Charlotte --limit 5
//   railway variables --json | node scripts/backfill-websites.js --city Charlotte

const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const CITY = argVal("--city");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class FatalError extends Error {}

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });
}

async function fetchWebsite(apiKey, placeId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "websiteUri" },
    });
    if (res.status === 403 || res.status === 401) {
      throw new FatalError(`Places API auth error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    if (res.status === 404) return null;
    if (res.status === 429) { await delay(2000 * attempt); continue; }
    if (!res.ok) {
      if (attempt === 3) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await delay(1000 * attempt);
      continue;
    }
    return (await res.json()).websiteUri || null;
  }
  throw new Error("rate limited after 3 attempts");
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const API_KEY = env("GOOGLE_PLACES_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY || !API_KEY) {
    throw new FatalError("Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const venues = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("venues")
      .select("id, name, city, google_place_id")
      .not("google_place_id", "is", null)
      .is("website", null)
      .order("id")
      .range(from, from + 999);
    if (CITY) q = q.eq("city", CITY);
    const { data, error } = await q;
    if (error) throw new FatalError(`venues query failed: ${error.message}`);
    venues.push(...data);
    if (data.length < 1000) break;
  }
  const toRun = venues.slice(0, LIMIT);
  console.log(`Venues needing website${CITY ? ` in ${CITY}` : ""}: ${venues.length} | processing ${toRun.length}`);

  let updated = 0, none = 0;
  const failed = [];
  for (const [i, v] of toRun.entries()) {
    try {
      const website = await fetchWebsite(API_KEY, v.google_place_id);
      if (website) {
        const { error } = await supabase.from("venues").update({ website }).eq("id", v.id);
        if (error) throw new FatalError(`update failed for ${v.name}: ${error.message}`);
        updated++;
      } else {
        none++;
      }
    } catch (err) {
      if (err instanceof FatalError) throw err;
      failed.push(`${v.name}: ${err.message}`);
    }
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${toRun.length} (updated ${updated}, no-website ${none})`);
    await delay(60);
  }

  console.log(`\nUpdated: ${updated} | No website on Google: ${none} | Failed: ${failed.length}`);
  failed.slice(0, 10).forEach((f) => console.log(`  FAIL ${f}`));
}

main().catch((err) => {
  console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err);
  process.exit(1);
});
