// Area-based venue import for downtown Saratoga Springs. Google Places (New)
// searchNearby over the downtown core (radius wide enough to reach Trackside
// Grill and Horseshoe Inn). DRY RUN by default; --write upserts on
// google_place_id. Mirrors charlotte-loso-import.js.
//
// Env via stdin: railway variables --json | node scripts/saratoga-downtown-import.js [--write]

const { createClient } = require("@supabase/supabase-js");

const WRITE = process.argv.includes("--write");
const CITY = "Saratoga Springs";

// One wide circle over downtown — 1900m reaches Trackside (Wright St, ~1320m)
// and Horseshoe Inn (Gridley St, ~1674m) from the Broadway/Caroline center.
const AREAS = [{ label: "Downtown", lat: 43.0805, lng: -73.7852, radius: 1900 }];
const TYPES = ["bar", "night_club", "restaurant"];
const MUST_APPEAR = ["trackside", "horseshoe"]; // Sweet Mimi's already in DB
const EXCLUDE = /chick-fil-a|mcdonald|taco bell|krispy kreme|chipotle|cook out|quiktrip|starbucks|dunkin|subway|wendy|burger king|popeyes|hardee|arby|panera|jersey mike|jimmy john|food truck|\bcoffee\b|gas station|7-eleven|circle k|sheetz|\bwawa\b|five guys|penn station|meal prep|ben & jerry|ice cream|anderlee|dz restaurants/i;
const EXCLUDE_ADDR = /$^/; // none for Saratoga

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
  if (!res.ok) { console.warn(`  search ${type}/${rankPreference} -> HTTP ${res.status}`); return []; }
  return (await res.json()).places || [];
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL"), SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY"), API_KEY = env("GOOGLE_PLACES_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY || !API_KEY) throw new FatalError("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY");
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const found = new Map();
  for (const area of AREAS) for (const type of TYPES) for (const rank of ["POPULARITY", "DISTANCE"]) {
    const places = await searchNearby(API_KEY, area, type, rank);
    for (const p of places) {
      if (!p.id || !p.location) continue;
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
      if (!found.has(p.id)) found.set(p.id, p);
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
  }));

  console.log(`\nDowntown Saratoga: unique operational ${found.size}, already in DB ${found.size - news.length}, NEW ${news.length}\n`);
  console.log("=== NEW VENUES (dry run) ===");
  news.sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => console.log(`  + ${n.name} [${n.category}] — ${n.address}`));

  console.log("\n=== MUST-APPEAR CHECK ===");
  const allNames = news.map((n) => n.name.toLowerCase());
  let missing = 0;
  for (const needle of MUST_APPEAR) { const hit = allNames.some((nm) => nm.includes(needle)); console.log(`  ${hit ? "OK  " : "MISS"} ${needle}`); if (!hit) missing++; }
  if (missing) console.log(`\n!! ${missing} expected venue(s) NOT in the diff — review before writing.`);

  if (!WRITE) { console.log("\nDRY RUN complete. Re-run with --write to commit.\n"); return; }

  console.log("\n=== WRITING (upsert on google_place_id) ===");
  let wrote = 0;
  for (const n of news) {
    const row = { name: n.name, address: n.address, neighborhood: "Downtown", city: CITY, latitude: n.latitude, longitude: n.longitude, category: n.category, phone: n.place.nationalPhoneNumber || null, website: n.place.websiteUri || null, google_place_id: n.place.id };
    const { error } = await supabase.from("venues").upsert(row, { onConflict: "google_place_id" });
    if (error) { console.log(`  FAIL ${n.name} — ${error.message}`); continue; }
    wrote++;
  }
  console.log(`\nWrote ${wrote} venues.`);
}

main().catch((err) => { console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err); process.exit(1); });
