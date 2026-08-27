// Shared loader for BestTime's stored-venue list with an on-disk cache.
//
// Query Venues All is one of the priciest BestTime endpoints (~69 credits per
// page in practice — the Aug 2026 invoice traced ~75% of all spend to chunked
// import runs each re-downloading the full list). Chunked runs of
// add-besttime/sync-besttime must reuse one download per session instead of
// re-listing on every invocation. Duplicate-add protection does NOT depend on
// this list being fresh: add-besttime skips anything already in
// venue_typical_hours, which is flushed after every paid forecast.
const fs = require("fs");
const path = require("path");

const CACHE_PATH = path.join(__dirname, ".besttime-venues-cache.json");
const DEFAULT_MAX_AGE_HOURS = 12;

async function loadStoredVenues(privateKey, fetcher, { force = false, maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (!force && fs.existsSync(CACHE_PATH)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      const ageH = (Date.now() - new Date(cached.fetched_at).getTime()) / 3600000;
      if (Array.isArray(cached.venues) && ageH < maxAgeHours) {
        console.log(`BestTime venue list: using cache (${cached.venues.length} venues, ${ageH.toFixed(1)}h old) — pass --refresh-venues to re-download`);
        return cached.venues;
      }
    } catch { /* unreadable cache — fall through to a fresh download */ }
  }
  const venues = [];
  for (let page = 0; ; page++) {
    const batch = await fetcher(
      `https://besttime.app/api/v1/venues?api_key_private=${privateKey}&page=${page}`,
      `venue list page ${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    venues.push(...batch);
    if (batch.length < 1000) break;
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetched_at: new Date().toISOString(), venues }));
  console.log(`BestTime venue list: downloaded ${venues.length} venues (cached ${maxAgeHours}h at ${path.basename(CACHE_PATH)})`);
  return venues;
}

module.exports = { loadStoredVenues, CACHE_PATH };
