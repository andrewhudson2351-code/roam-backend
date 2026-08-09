// Backfill venues.dog_friendly from Google Places (New) `allowsDogs`.
// COSTS MONEY: Place Details with allowsDogs bills the Enterprise+Atmosphere
// SKU (~$0.025/call). Only fetches venues where dog_friendly IS NULL, so
// re-runs touch only new venues. Writes per venue — safe to kill.
//
// Usage: railway variables --json | node scripts/backfill-dog-friendly.js [--city X] [--categories Bar,Club,Venue] [--limit N] [--go]

const { createClient } = require("@supabase/supabase-js");

const argVal = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const CITY = argVal("--city");
const SINCE = argVal("--since"); // only venues created on/after this (ISO date/timestamp)
const CATS = (argVal("--categories") || "Bar,Club,Venue").split(",").map((s) => s.trim());
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const GO = process.argv.includes("--go");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const API_KEY = env("GOOGLE_PLACES_API_KEY");
  if (!API_KEY) throw new Error("GOOGLE_PLACES_API_KEY missing");

  let q = supabase.from("venues").select("id, name, city, google_place_id")
    .is("dog_friendly", null).not("google_place_id", "is", null).in("category", CATS);
  if (CITY) q = q.eq("city", CITY);
  if (SINCE) q = q.gte("created_at", SINCE);
  const { data: venues, error } = await q;
  if (error) throw new Error(error.message);
  const targets = venues.slice(0, LIMIT);
  console.log(`Venues needing dog_friendly (${CATS.join("/")}${CITY ? ", " + CITY : ""}${SINCE ? ", since " + SINCE : ""}): ${venues.length} | this run: ${targets.length}`);
  console.log(`Worst-case cost: ~$${(targets.length * 0.025).toFixed(2)} (Enterprise SKU)`);
  if (!GO) { console.log("Dry run — pass --go to spend."); return; }

  let yes = 0, no = 0, unknown = 0, failed = 0;
  for (const [i, v] of targets.entries()) {
    try {
      const res = await fetch(`https://places.googleapis.com/v1/places/${v.google_place_id}`, {
        headers: { "X-Goog-Api-Key": API_KEY, "X-Goog-FieldMask": "allowsDogs" },
      });
      if (res.status === 401 || res.status === 403) throw new Error(`auth ${res.status}: ${(await res.text()).slice(0, 150)}`);
      if (!res.ok) { failed++; await delay(150); continue; }
      const j = await res.json();
      // true -> dog friendly; explicit false -> not; absent -> false too (the
      // filter only surfaces true, and null would mean "retry forever").
      const val = j.allowsDogs === true;
      if (j.allowsDogs === true) yes++; else if (j.allowsDogs === false) no++; else unknown++;
      await supabase.from("venues").update({ dog_friendly: val }).eq("id", v.id);
    } catch (e) {
      if (/auth /.test(e.message)) throw e;
      failed++;
    }
    if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${targets.length} (dog-friendly so far: ${yes})`);
    await delay(120);
  }
  console.log(`Done. dog_friendly=true: ${yes} | explicit no: ${no} | no data (stored false): ${unknown} | fetch failures (left null): ${failed}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
