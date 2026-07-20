// Find venues by name via Google Places Text Search (New) and insert any that
// aren't already in the DB. Dedupes on google_place_id and name+city.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY
//   (missing vars are read from a JSON object piped to stdin — railway variables --json)
//
// Usage:
//   railway variables --json | node scripts/add-venues.js --city "Saratoga Springs" "Sweet Mimi's" "Icebox"
//   railway variables --json | node scripts/add-venues.js --city Charlotte "Brewers at 4001 Yancey"

const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const cityIdx = args.indexOf("--city");
const CITY = cityIdx !== -1 ? args[cityIdx + 1] : null;
const QUERIES = args.filter((a, i) => a !== "--city" && i !== cityIdx + 1 && !a.startsWith("--"));

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

// Map Google place types to our category check-constraint (Bar|Club|Restaurant|Venue).
function toCategory(primaryType, types = []) {
  const t = new Set([primaryType, ...types]);
  if (t.has("night_club")) return "Club";
  if (t.has("bar") || t.has("pub") || t.has("wine_bar") || t.has("brewery")) return "Bar";
  if (t.has("restaurant") || t.has("cafe") || t.has("meal_takeaway") || t.has("bakery") || t.has("food")) return "Restaurant";
  if (t.has("performing_arts_theater") || t.has("concert_hall") || t.has("event_venue") || t.has("tourist_attraction")) return "Venue";
  return "Bar";
}

function neighborhoodFrom(components = [], fallback) {
  const byType = (type) => components.find((c) => (c.types || []).includes(type))?.longText;
  return byType("neighborhood") || byType("sublocality") || byType("sublocality_level_1") || fallback;
}

async function textSearch(apiKey, query) {
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.primaryType,places.types,places.nationalPhoneNumber,places.websiteUri,places.addressComponents,places.businessStatus",
    },
    body: JSON.stringify({ textQuery: query, maxResultCount: 1 }),
  });
  if (res.status === 401 || res.status === 403) throw new FatalError(`Places auth error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  return { place: (j.places || [])[0] || null };
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL"), SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY"), API_KEY = env("GOOGLE_PLACES_API_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY || !API_KEY) throw new FatalError("Missing env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_PLACES_API_KEY");
  if (!CITY || QUERIES.length === 0) throw new FatalError('Usage: --city "<City>" "<Venue Name>" ["<Venue Name>" ...]');
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  for (const q of QUERIES) {
    const query = `${q}, ${CITY}`;
    const { place, error } = await textSearch(API_KEY, query);
    if (error) { console.log(`SKIP  "${q}" — search failed (${error})`); continue; }
    if (!place) { console.log(`SKIP  "${q}" — no Places match`); continue; }
    if (place.businessStatus && place.businessStatus !== "OPERATIONAL") { console.log(`SKIP  "${q}" — ${place.businessStatus}`); continue; }

    // Dedupe
    const { data: byPlace } = await supabase.from("venues").select("id").eq("google_place_id", place.id).maybeSingle();
    if (byPlace) { console.log(`DUP   "${q}" — already in DB (place_id)`); continue; }
    const name = place.displayName?.text || q;
    const { data: byName } = await supabase.from("venues").select("id").eq("city", CITY).ilike("name", name).maybeSingle();
    if (byName) { console.log(`DUP   "${q}" — already in DB (name)`); continue; }

    const row = {
      name,
      address: place.formattedAddress || "",
      neighborhood: neighborhoodFrom(place.addressComponents, CITY),
      city: CITY,
      latitude: place.location?.latitude,
      longitude: place.location?.longitude,
      category: toCategory(place.primaryType, place.types),
      phone: place.nationalPhoneNumber || null,
      website: place.websiteUri || null,
      google_place_id: place.id,
    };
    if (row.latitude == null || row.longitude == null) { console.log(`SKIP  "${q}" — no coordinates`); continue; }
    const { error: insErr } = await supabase.from("venues").insert(row);
    if (insErr) { console.log(`FAIL  "${q}" — ${insErr.message}`); continue; }
    console.log(`ADDED ${name} [${row.category}] — ${row.address}`);
    await delay(120);
  }
}

main().catch((err) => { console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err); process.exit(1); });
