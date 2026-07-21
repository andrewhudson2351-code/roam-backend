// Area-based venue import for the South End -> LoSo stretch of the
// Uptown->South End->LoSo corridor. Google Places (New) searchNearby over two
// circles. DRY RUN by default (prints a diff of new venues); pass --write to
// upsert into prod on google_place_id (never creates dupes).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY
//   (missing vars read from JSON piped to stdin — railway variables --json)
//
// Usage:
//   railway variables --json | node scripts/charlotte-loso-import.js          # dry run
//   railway variables --json | node scripts/charlotte-loso-import.js --write  # commit

const { createClient } = require("@supabase/supabase-js");

const WRITE = process.argv.includes("--write");
const CITY = "Charlotte";

// Two new search areas. Mid South End bridges core South End (already covered)
// and the LoSo/Yancey cluster.
const AREAS = [
  { label: "South End", lat: 35.2032, lng: -80.8642, radius: 800 },
  { label: "LoSo", lat: 35.1873, lng: -80.8818, radius: 1200 },
];
// App categories; brewery/distillery/cidery taprooms type as "bar" in Places.
const TYPES = ["bar", "night_club", "restaurant"];
// Task 3: these must show up in the diff or we stop and report.
const MUST_APPEAR = ["southbound", "backstage lounge", "sugar creek brew", "good road cider", "great wagon road", "broken spoke", "doc porter", "queen park social"];

// Exclude non-nightlife: fast food, coffee/gas/convenience chains, food-hall
// micro-vendors, cooking school, meal-prep, tiendas. Same intent as the earlier
// venue cleanup — keep the corridor to real bars/breweries/clubs/restaurants.
const EXCLUDE = /chick-fil-a|mcdonald|taco bell|krispy kreme|chipotle|cook out|quiktrip|starbucks|dunkin|subway|wendy|burger king|popeyes|bojangles|hardee|arby|panera|jersey mike|jimmy john|food truck|\bcoffee\b|gas station|7-eleven|circle k|sheetz|\bwawa\b|five guys|penn station|chef alyssa|table & twine|table and twine|\btienda\b|kabab 2 go|meal prep|naked farmer|dulce y salado|el sartenazo|las delicias|donde nanchis|family crepes|\bla fogata\b|mi pais/i;
// Food-hall stall clusters (industrial addresses, not nightlife).
const EXCLUDE_ADDR = /Yeoman Rd/i;

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
  if (t.has("bar") || t.has("pub") || t.has("wine_bar") || t.has("brewery")) return "Bar";
  if (t.has("restaurant") || t.has("cafe") || t.has("meal_takeaway") || t.has("bakery") || t.has("food")) return "Restaurant";
  return "Bar";
}

const dist = (aLat, aLng, bLat, bLng) => Math.hypot(aLat - bLat, aLng - bLng);
function nearestAreaLabel(lat, lng) {
  let best = AREAS[0];
  for (const a of AREAS) if (dist(lat, lng, a.lat, a.lng) < dist(lat, lng, best.lat, best.lng)) best = a;
  return best.label;
}

// searchNearby caps at 20 results with no pagination, so a dense area truncates.
// We run BOTH rank preferences per type: POPULARITY (top prominent) and DISTANCE
// (nearest to center) — the union captures both the well-known spots and the
// smaller in-range venues the popularity ranking drops (e.g. SouthBound).
async function searchNearby(apiKey, area, type, rankPreference) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.nationalPhoneNumber,places.websiteUri,places.businessStatus",
    },
    body: JSON.stringify({
      includedTypes: [type],
      maxResultCount: 20,
      rankPreference,
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

  // Gather + dedupe by place_id
  const found = new Map();
  for (const area of AREAS) {
    for (const type of TYPES) {
      for (const rank of ["POPULARITY", "DISTANCE"]) {
        const places = await searchNearby(API_KEY, area, type, rank);
        for (const p of places) {
          if (!p.id || !p.location) continue;
          if (p.businessStatus && p.businessStatus !== "OPERATIONAL") continue;
          if (!found.has(p.id)) found.set(p.id, p);
        }
        await delay(120);
      }
    }
  }

  // Existing place_ids in the DB
  const existing = new Set();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("venues").select("google_place_id").not("google_place_id", "is", null).range(from, from + 999);
    if (error) throw new FatalError(`existing query failed: ${error.message}`);
    data.forEach((r) => existing.add(r.google_place_id));
    if (data.length < 1000) break;
  }

  const news = [...found.values()].filter((p) => !existing.has(p.id) && !EXCLUDE.test(p.displayName?.text || "") && !EXCLUDE_ADDR.test(p.formattedAddress || "")).map((p) => ({
    place: p,
    name: p.displayName?.text || "",
    address: p.formattedAddress || "",
    neighborhood: nearestAreaLabel(p.location.latitude, p.location.longitude),
    latitude: p.location.latitude,
    longitude: p.location.longitude,
    category: toCategory(p.primaryType, p.types),
  }));

  console.log(`\nSearched ${AREAS.length} areas x ${TYPES.length} types. Unique operational places: ${found.size}. Already in DB: ${found.size - news.length}. NEW: ${news.length}\n`);
  console.log("=== NEW VENUES (dry run — not written unless --write) ===");
  for (const label of AREAS.map((a) => a.label)) {
    const group = news.filter((n) => n.neighborhood === label);
    if (!group.length) continue;
    console.log(`\n[${label}] ${group.length}`);
    group.sort((a, b) => a.name.localeCompare(b.name)).forEach((n) => console.log(`  + ${n.name} [${n.category}] — ${n.address}`));
  }

  console.log("\n=== MUST-APPEAR CHECK ===");
  const allNames = news.map((n) => n.name.toLowerCase());
  let missing = 0;
  for (const needle of MUST_APPEAR) {
    const hit = allNames.some((nm) => nm.includes(needle));
    console.log(`  ${hit ? "OK  " : "MISS"} ${needle}`);
    if (!hit) missing++;
  }
  if (missing) console.log(`\n!! ${missing} expected venue(s) NOT in the diff — review before writing.`);

  if (!WRITE) { console.log("\nDRY RUN complete. Re-run with --write to commit.\n"); return; }

  console.log("\n=== WRITING (upsert on google_place_id) ===");
  let wrote = 0;
  for (const n of news) {
    const row = {
      name: n.name, address: n.address, neighborhood: n.neighborhood, city: CITY,
      latitude: n.latitude, longitude: n.longitude, category: n.category,
      phone: n.place.nationalPhoneNumber || null, website: n.place.websiteUri || null,
      google_place_id: n.place.id,
    };
    const { error } = await supabase.from("venues").upsert(row, { onConflict: "google_place_id" });
    if (error) { console.log(`  FAIL ${n.name} — ${error.message}`); continue; }
    wrote++;
  }
  console.log(`\nWrote ${wrote} venues.`);
}

main().catch((err) => { console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err); process.exit(1); });
