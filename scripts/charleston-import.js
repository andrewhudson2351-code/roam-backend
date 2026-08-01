// Area-based venue import for Charleston SC — city #13. Google Places (New)
// searchNearby across the brewery/nightlife districts. Areas and radii are
// sized so every major brewery lands inside a circle (see MUST_APPEAR).
// DRY RUN by default; --write upserts on google_place_id.
// Mirrors saratoga-downtown-import.js.
//
// Env via stdin: railway variables --json | node scripts/charleston-import.js [--write]

const { createClient } = require("@supabase/supabase-js");

const WRITE = process.argv.includes("--write");
const CITY = "Charleston";

const AREAS = [
  { label: "Upper King",        lat: 32.7935, lng: -79.9400, radius: 1100 }, // Prohibition, Uptown Social
  { label: "Market / French Quarter", lat: 32.7805, lng: -79.9295, radius: 1100 }, // Henry's, The Griffon, Big John's
  { label: "NoMo",              lat: 32.8060, lng: -79.9470, radius: 2000 }, // Edmund's Oast, Revelry
  { label: "West Ashley",       lat: 32.7920, lng: -80.0060, radius: 1600 }, // Avondale strip
  { label: "Mount Pleasant",    lat: 32.7920, lng: -79.8870, radius: 2200 }, // Shem Creek
  { label: "Sullivan's Island", lat: 32.7620, lng: -79.8420, radius: 1500 }, // Poe's Tavern, Middle St
  { label: "Isle of Palms",     lat: 32.7860, lng: -79.7950, radius: 1800 }, // The Windjammer
  { label: "Folly Beach",       lat: 32.6560, lng: -79.9410, radius: 1800 },
  { label: "Park Circle",       lat: 32.8730, lng: -79.9800, radius: 1600 }, // Commonhouse Aleworks
  { label: "James Island",      lat: 32.7340, lng: -79.9640, radius: 3200 }, // The Pour House
];
// "brewery"/"pub" are valid Places (New) Table A types; if a type 400s, that
// call logs a warning and returns [] without sinking the run.
const TYPES = ["bar", "brewery", "pub", "night_club", "restaurant"];
const MUST_APPEAR = [
  "revelry", "edmund", "prohibition", "henry", "griffon",
  "pour house", "windjammer", "poe", "red's ice", "commonhouse",
];
const EXCLUDE = /chick-fil-a|mcdonald|taco bell|krispy kreme|chipotle|cook out|quiktrip|starbucks|dunkin|subway|wendy|burger king|popeyes|hardee|arby|panera|jersey mike|jimmy john|food truck|\bcoffee\b|gas station|7-eleven|circle k|sheetz|\bwawa\b|five guys|penn station|meal prep|ben & jerry|ice cream|waffle house|bojangles|zaxby|golden corral|cracker barrel|ihop|denny/i;
const EXCLUDE_ADDR = /$^/;

class FatalError extends Error {}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function toCategory(primaryType, types = []) {
  const t = new Set([primaryType, ...(types || [])]);
  if (t.has("night_club")) return "Club";
  if (t.has("bar") || t.has("pub") || t.has("wine_bar") || t.has("brewery") || t.has("bar_and_grill")) return "Bar";
  if (t.has("restaurant") || t.has("cafe") || t.has("meal_takeaway") || t.has("bakery") || t.has("food")) return "Restaurant";
  return "Bar";
}

async function searchNearby(apiKey, area, type, rankPreference) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.nationalPhoneNumber,places.websiteUri,places.businessStatus",
    },
    body: JSON.stringify({
      includedTypes: [type], maxResultCount: 20, rankPreference,
      locationRestriction: { circle: { center: { latitude: area.lat, longitude: area.lng }, radius: area.radius } },
    }),
  });
  if (res.status === 401 || res.status === 403) throw new FatalError(`Places auth ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) { console.warn(`  search ${area.label}/${type}/${rankPreference} -> HTTP ${res.status}`); return []; }
  return (await res.json()).places || [];
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL"), SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY"), API_KEY = env("GOOGLE_PLACES_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY || !API_KEY) throw new FatalError("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY");
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const found = new Map();          // place_id -> place
  const areaOf = new Map();         // place_id -> first area label (neighborhood)
  for (const area of AREAS) for (const type of TYPES) for (const rank of ["POPULARITY", "DISTANCE"]) {
    const places = await searchNearby(API_KEY, area, type, rank);
    for (const p of places) {
      if (!p.id || !p.location) continue;
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      if (!found.has(p.id)) { found.set(p.id, p); areaOf.set(p.id, area.label); }
    }
    await delay(120);
  }

  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("venues").select("google_place_id").not("google_place_id", "is", null).range(from, from + 999);
    if (error) throw new FatalError(`existing query failed: ${error.message}`);
    data.forEach((r) => existing.add(r.google_place_id));
    if (data.length < 1000) break;
  }

  const news = [...found.values()].filter((p) => !existing.has(p.id) && !EXCLUDE.test(p.displayName?.text || "") && !EXCLUDE_ADDR.test(p.formattedAddress || "")).map((p) => ({
    place: p, name: p.displayName?.text || "", address: p.formattedAddress || "",
    latitude: p.location.latitude, longitude: p.location.longitude,
    category: toCategory(p.primaryType, p.types),
    neighborhood: areaOf.get(p.id) || "Asheville",
  }));

  console.log(`\nCharleston: unique operational ${found.size}, already in DB ${found.size - news.length}, NEW ${news.length}\n`);
  console.log("=== NEW VENUES (dry run) ===");
  news.sort((a, b) => a.neighborhood.localeCompare(b.neighborhood) || a.name.localeCompare(b.name)).forEach((n) => console.log(`  + [${n.neighborhood}] ${n.name} [${n.category}] — ${n.address}`));

  console.log("\n=== MUST-APPEAR CHECK (major breweries) ===");
  const allNames = news.map((n) => n.name.toLowerCase());
  let missing = 0;
  for (const needle of MUST_APPEAR) { const hit = allNames.some((nm) => nm.includes(needle)); console.log(`  ${hit ? "OK  " : "MISS"} ${needle}`); if (!hit) missing++; }
  if (missing) console.log(`\n!! ${missing} expected venue(s) NOT in the diff — widen the area/radius before writing.`);

  if (!WRITE) { console.log("\nDRY RUN complete. Re-run with --write to commit.\n"); return; }

  console.log("\n=== WRITING (upsert on google_place_id) ===");
  let wrote = 0;
  for (const n of news) {
    const row = { name: n.name, address: n.address, neighborhood: n.neighborhood, city: CITY, latitude: n.latitude, longitude: n.longitude, category: n.category, phone: n.place.nationalPhoneNumber || null, website: n.place.websiteUri || null, google_place_id: n.place.id };
    const { error } = await supabase.from("venues").upsert(row, { onConflict: "google_place_id" });
    if (error) { console.log(`  FAIL ${n.name} — ${error.message}`); continue; }
    wrote++;
  }
  console.log(`\nWrote ${wrote} venues.`);
}

main().catch((err) => { console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err); process.exit(1); });
