// Add venues to BestTime via new-forecast calls and store their baselines.
// COSTS MONEY: 2 credits per successful forecast, 1 per failed (~$0.04/credit).
// Skips venues already in BestTime's stored list (paginated, free to read).
// Baselines are upserted straight from the forecast response (no extra query credits).
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BESTTIME_API_KEY_PRIVATE
// (missing vars read from stdin JSON, i.e. `railway variables --json | ...`).
//
// Usage:
//   railway variables --json | node scripts/add-besttime.js --since 2026-07-21          (dry run)
//   railway variables --json | node scripts/add-besttime.js --since 2026-07-21 --go
//   railway variables --json | node scripts/add-besttime.js --since 2026-07-21 --go --limit 5

const { createClient } = require("@supabase/supabase-js");

const DAY_TEXT = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MATCH_RADIUS_M = 200;
const MAX_VENUES = 200; // hard safety cap per run

const argVal = (flag) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
};
const SINCE = argVal("--since");
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const GO = process.argv.includes("--go");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

class FatalError extends Error {}

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function normName(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(the|bar|restaurant|lounge|club|grill|kitchen|and)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameSimilar(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  if (na === nb || na.includes(nb) || nb.includes(na)) return true;
  const ta = new Set(na.split(" ")), tb = new Set(nb.split(" "));
  const overlap = [...ta].filter((t) => tb.has(t)).length;
  return overlap / Math.min(ta.size, tb.size) >= 0.6;
}

function haversineM(lat1, lng1, lat2, lng2) {
  const R = 6371000, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const PRIVATE_KEY = env("BESTTIME_API_KEY_PRIVATE");
  if (!SINCE) throw new FatalError("--since YYYY-MM-DD is required");
  if (!env("SUPABASE_URL") || !env("SUPABASE_SERVICE_ROLE_KEY") || !PRIVATE_KEY) {
    throw new FatalError("Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BESTTIME_API_KEY_PRIVATE");
  }
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  // Stored list (free), paginated at 1000/page.
  const stored = [];
  for (let page = 0; ; page++) {
    const res = await fetch(`https://besttime.app/api/v1/venues?api_key_private=${PRIVATE_KEY}&page=${page}`);
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    stored.push(...batch);
    if (batch.length < 1000) break;
  }
  console.log(`BestTime stored venues: ${stored.length}`);

  const { data: candidates, error } = await supabase
    .from("venues")
    .select("id, name, address, city, latitude, longitude")
    .gte("created_at", SINCE);
  if (error) throw new FatalError(`venues query failed: ${error.message}`);

  const { data: haveHours, error: hErr } = await supabase
    .from("venue_typical_hours")
    .select("venue_id")
    .in("venue_id", candidates.map((v) => v.id));
  if (hErr) throw new FatalError(`hours query failed: ${hErr.message}`);
  const withBaseline = new Set(haveHours.map((r) => r.venue_id));

  const inBestTime = (v) =>
    stored.some((bt) => {
      if (normName(bt.venue_name) === normName(v.name)) return true;
      return (
        bt.venue_lat != null && v.latitude != null &&
        haversineM(bt.venue_lat, bt.venue_lng, v.latitude, v.longitude) <= MATCH_RADIUS_M &&
        nameSimilar(bt.venue_name, v.name)
      );
    });

  const targets = candidates
    .filter((v) => !withBaseline.has(v.id) && v.address && !inBestTime(v))
    .slice(0, Math.min(LIMIT, MAX_VENUES));

  console.log(`Venues since ${SINCE}: ${candidates.length} | to add: ${targets.length}`);
  console.log(`Worst-case cost: ${targets.length * 2} credits (~$${(targets.length * 2 * 0.04).toFixed(2)} at $0.04/credit)`);
  targets.forEach((v) => console.log(`  - ${v.name} (${v.city})`));
  if (!GO) {
    console.log("\nDry run — pass --go to spend credits.");
    return;
  }

  let ok = 0, failed = 0, credits = 0;
  const rows = [];
  const failures = [];
  for (const [i, v] of targets.entries()) {
    const params = new URLSearchParams({
      api_key_private: PRIVATE_KEY,
      venue_name: v.name,
      venue_address: v.address,
    });
    let body = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`https://besttime.app/api/v1/forecasts?${params}`, { method: "POST" });
        body = await res.json();
        const msg = typeof body.message === "string" ? body.message : JSON.stringify(body.message || "");
        if (/credit/i.test(msg)) throw new FatalError(`BestTime credits exhausted: ${msg}`);
        if (res.status >= 500) throw new Error(`HTTP ${res.status}: ${msg.slice(0, 120)}`);
        break; // 2xx and 4xx are both final answers
      } catch (err) {
        if (err instanceof FatalError) throw err;
        if (attempt === 3) { body = { status: "Error", message: err.message }; }
        else await delay(2000 * attempt);
      }
    }
    const analysis = body && body.status === "OK" ? body.analysis : null;
    const valid = Array.isArray(analysis) && analysis.length === 7 &&
      analysis.every((d) => d.day_info && Number.isInteger(d.day_info.day_int) && Array.isArray(d.day_raw) && d.day_raw.length === 24);
    if (valid) {
      ok++; credits += 2;
      const now = new Date().toISOString();
      for (const d of analysis) {
        rows.push({
          venue_id: v.id,
          day_int: d.day_info.day_int,
          day_text: DAY_TEXT[d.day_info.day_int],
          hour_data: d.day_raw,
          fetched_at: now,
        });
      }
      console.log(`  OK   ${v.name} (${v.city})`);
    } else {
      failed++; credits += 1;
      const msg = body ? (typeof body.message === "string" ? body.message : JSON.stringify(body.message || body.status)) : "no response";
      failures.push({ name: v.name, city: v.city, msg });
      console.log(`  FAIL ${v.name} (${v.city}): ${String(msg).slice(0, 100)}`);
    }
    if ((i + 1) % 20 === 0) console.log(`  ...${i + 1}/${targets.length} (credits so far: ~${credits})`);
    await delay(500);
  }

  for (let i = 0; i < rows.length; i += 500) {
    const { error: upErr } = await supabase
      .from("venue_typical_hours")
      .upsert(rows.slice(i, i + 500), { onConflict: "venue_id,day_int" });
    if (upErr) throw new FatalError(`upsert failed at chunk ${i / 500}: ${upErr.message}`);
  }

  console.log(`\nDone. Forecasted: ${ok} | No data: ${failed} | Baseline rows upserted: ${rows.length}`);
  console.log(`Estimated credits spent: ~${credits} (~$${(credits * 0.04).toFixed(2)} at $0.04/credit)`);
  if (failures.length) {
    console.log(`\nNo foot-traffic data (not added):`);
    failures.forEach((f) => console.log(`  - ${f.name} (${f.city})`));
  }
}

main().catch((err) => {
  console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err);
  process.exit(1);
});
