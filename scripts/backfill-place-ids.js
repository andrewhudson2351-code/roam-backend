// Backfill venues.google_place_id via Places API (New) Text Search.
// Field mask places.id,places.location bills the Text Search Pro SKU:
// 5,000 free events/month, so a full run over ~1,700 venues costs $0.
// Matches are verified by distance (<= MAX_DIST_M from our stored coords).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY.
// Missing env vars are read from a JSON object piped to stdin (railway variables --json).
//
// Usage:
//   railway variables --json | node scripts/backfill-place-ids.js --limit 5
//   railway variables --json | node scripts/backfill-place-ids.js --city Charlotte
//   railway variables --json | node scripts/backfill-place-ids.js          (full run)

const { createClient } = require("@supabase/supabase-js");

const MAX_DIST_M = 250;

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

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function searchPlace(apiKey, venue) {
  const body = {
    textQuery: `${venue.name}, ${venue.address}, ${venue.city}`,
    pageSize: 1,
    locationBias: {
      circle: { center: { latitude: venue.latitude, longitude: venue.longitude }, radius: 500 },
    },
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": "places.id,places.location",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 403 || res.status === 401) {
      const t = await res.text();
      throw new FatalError(`Places API auth error ${res.status}: ${t.slice(0, 300)}`);
    }
    if (res.status === 429) { await delay(2000 * attempt); continue; }
    if (!res.ok) {
      if (attempt === 3) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await delay(1000 * attempt);
      continue;
    }
    return (await res.json()).places?.[0] || null;
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
      .select("id, name, address, city, latitude, longitude")
      .is("google_place_id", null)
      .order("id")
      .range(from, from + 999);
    if (CITY) q = q.eq("city", CITY);
    const { data, error } = await q;
    if (error) throw new FatalError(`venues query failed: ${error.message}`);
    venues.push(...data);
    if (data.length < 1000) break;
  }
  const toRun = venues.slice(0, LIMIT);
  console.log(`Venues without place_id${CITY ? ` in ${CITY}` : ""}: ${venues.length} | processing ${toRun.length}`);

  let matched = 0;
  const unmatched = [];
  const failed = [];
  for (const [i, v] of toRun.entries()) {
    try {
      const place = await searchPlace(API_KEY, v);
      const dist = place?.location
        ? Math.round(haversineM(place.location.latitude, place.location.longitude, v.latitude, v.longitude))
        : Infinity;
      if (place?.id && dist <= MAX_DIST_M) {
        const { error } = await supabase.from("venues").update({ google_place_id: place.id }).eq("id", v.id);
        if (error) throw new FatalError(`update failed for ${v.name}: ${error.message}`);
        matched++;
      } else {
        unmatched.push(`${v.name} (${v.city})${place ? ` — nearest result ${dist}m away` : " — no result"}`);
      }
    } catch (err) {
      if (err instanceof FatalError) throw err;
      failed.push(`${v.name}: ${err.message}`);
    }
    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${toRun.length} (matched ${matched})`);
    await delay(60);
  }

  console.log(`\nMatched: ${matched} | Unmatched: ${unmatched.length} | Failed: ${failed.length}`);
  unmatched.slice(0, 15).forEach((u) => console.log(`  UNMATCHED ${u}`));
  failed.slice(0, 10).forEach((f) => console.log(`  FAIL ${f}`));
}

main().catch((err) => {
  console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err);
  process.exit(1);
});
