// Sync venue_typical_hours from BestTime's STORED forecasts (no new-forecast credits).
// Flow: list stored venues (private key) -> match to our venues by coords+name ->
// query week/raw per venue (public key) -> sanity-check -> upsert 7 rows/venue.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BESTTIME_API_KEY_PRIVATE.
// Missing env vars are read from a JSON object piped to stdin (railway variables --json).
//
// Usage:
//   railway variables --json | node scripts/sync-besttime.js --limit 5
//   railway variables --json | node scripts/sync-besttime.js          (full run)

const { createClient } = require("@supabase/supabase-js");

const ALL_ZERO_ABORT_PCT = 20; // abort if > this % of fetched venues are all-zero/null
const DAY_TEXT = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MATCH_RADIUS_M = 200;

const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const skipArg = process.argv.indexOf("--skip-fresh-days");
const SKIP_FRESH_DAYS = skipArg !== -1 ? Number(process.argv[skipArg + 1]) : 0;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function btFetch(url, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url);
      const body = await res.json();
      const msg = typeof body.message === "string" ? body.message : JSON.stringify(body.message || "");
      if (/credit/i.test(msg)) throw new FatalError(`BestTime credits exhausted (${label}): ${msg}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (${label}): ${msg.slice(0, 200)}`);
      return body;
    } catch (err) {
      if (err instanceof FatalError || attempt === 3) throw err;
      await delay(1500 * attempt);
    }
  }
}

class FatalError extends Error {}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  const PRIVATE_KEY = env("BESTTIME_API_KEY_PRIVATE");
  if (!SUPABASE_URL || !SUPABASE_KEY || !PRIVATE_KEY) {
    throw new FatalError("Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, BESTTIME_API_KEY_PRIVATE");
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const keyInfo = await btFetch(`https://besttime.app/api/v1/keys/${PRIVATE_KEY}`, "key info");
  const PUBLIC_KEY = keyInfo.api_key_public;
  if (!PUBLIC_KEY) throw new FatalError("Could not resolve public key from private key");

  // The venue list is paginated (1000/page); loop until an empty page.
  const stored = [];
  for (let page = 0; ; page++) {
    const batch = await btFetch(
      `https://besttime.app/api/v1/venues?api_key_private=${PRIVATE_KEY}&page=${page}`,
      `venue list page ${page}`
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    stored.push(...batch);
    if (batch.length < 1000) break;
  }
  const forecasted = stored.filter((v) => v.venue_forecasted === true);
  console.log(`BestTime stored venues: ${stored.length} total, ${forecasted.length} forecasted`);

  const ours = [];
  for (let from = 0; ; from += 1000) {
    const { data, error: vErr } = await supabase
      .from("venues")
      .select("id, name, address, city, latitude, longitude")
      .range(from, from + 999);
    if (vErr) throw new FatalError(`venues query failed: ${vErr.message}`);
    ours.push(...data);
    if (data.length < 1000) break;
  }
  console.log(`Our venues: ${ours.length}`);

  // Match: nearest venue within MATCH_RADIUS_M with a similar name; fallback exact-name match.
  const matches = [];
  const unmatched = [];
  const claimed = new Set();
  for (const bt of forecasted) {
    let best = null;
    if (bt.venue_lat != null && bt.venue_lng != null) {
      for (const v of ours) {
        if (claimed.has(v.id) || v.latitude == null || v.longitude == null) continue;
        const d = haversineM(bt.venue_lat, bt.venue_lng, v.latitude, v.longitude);
        if (d <= MATCH_RADIUS_M && nameSimilar(bt.venue_name, v.name) && (!best || d < best.d)) {
          best = { v, d };
        }
      }
    }
    if (!best) {
      const exact = ours.find((v) => !claimed.has(v.id) && normName(v.name) === normName(bt.venue_name) && bt.venue_address.toLowerCase().includes((v.city || "").toLowerCase()));
      if (exact) best = { v: exact, d: -1 };
    }
    if (best) {
      claimed.add(best.v.id);
      matches.push({ bt, venue: best.v, dist: Math.round(best.d) });
    } else {
      unmatched.push({ name: bt.venue_name, address: bt.venue_address });
    }
  }
  console.log(`Matched: ${matches.length} | Unmatched (in BestTime, not in our DB): ${unmatched.length}`);

  // Optionally skip venues whose baseline was fetched recently (saves query credits on re-runs).
  let candidates = matches;
  if (SKIP_FRESH_DAYS > 0) {
    const cutoff = new Date(Date.now() - SKIP_FRESH_DAYS * 86400000).toISOString();
    const fresh = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("venue_typical_hours")
        .select("venue_id")
        .gte("fetched_at", cutoff)
        .range(from, from + 999);
      if (error) throw new FatalError(`freshness query failed: ${error.message}`);
      data.forEach((r) => fresh.add(r.venue_id));
      if (data.length < 1000) break;
    }
    candidates = matches.filter((m) => !fresh.has(m.venue.id));
    console.log(`Skipping ${matches.length - candidates.length} venue(s) synced within ${SKIP_FRESH_DAYS} day(s).`);
  }

  const toSync = candidates.slice(0, LIMIT);
  console.log(`Fetching week_raw for ${toSync.length} venue(s)...`);

  // Phase 1: fetch everything before writing anything.
  const fetched = [];
  const failed = [];
  for (const [i, m] of toSync.entries()) {
    try {
      const r = await btFetch(
        `https://besttime.app/api/v1/forecasts/week/raw?api_key_public=${PUBLIC_KEY}&venue_id=${m.bt.venue_id}`,
        m.bt.venue_name
      );
      const week = r?.analysis?.week_raw;
      if (!Array.isArray(week) || week.length !== 168) {
        throw new Error(`bad shape: week_raw ${Array.isArray(week) ? "len " + week.length : "missing"}`);
      }
      fetched.push({ ...m, week });
    } catch (err) {
      if (err instanceof FatalError) throw err;
      failed.push({ name: m.bt.venue_name, error: err.message });
    }
    if ((i + 1) % 50 === 0) console.log(`  ...${i + 1}/${toSync.length}`);
    await delay(200);
  }
  console.log(`Fetched OK: ${fetched.length} | Failed: ${failed.length}`);
  failed.slice(0, 10).forEach((f) => console.log(`  FAIL ${f.name}: ${f.error}`));

  // Sanity check: fail loudly if too many venues came back with no signal at all.
  const allZero = fetched.filter((f) => f.week.every((v) => v === null || v === 0));
  const pct = fetched.length ? (allZero.length / fetched.length) * 100 : 0;
  console.log(`All-zero venues: ${allZero.length}/${fetched.length} (${pct.toFixed(1)}%)`);
  if (fetched.length && pct > ALL_ZERO_ABORT_PCT) {
    allZero.slice(0, 10).forEach((f) => console.log(`  ALL-ZERO: ${f.bt.venue_name}`));
    throw new FatalError(
      `ABORT: ${pct.toFixed(1)}% of venues are all-zero (threshold ${ALL_ZERO_ABORT_PCT}%). ` +
      `This smells like the response-shape bug. Nothing was written.`
    );
  }

  // Phase 2: upsert. week_raw is 6am-anchored, index 0 = Monday 06:00 (same convention
  // as the existing day_raw rows). Nulls are preserved as nulls.
  const now = new Date().toISOString();
  const rows = [];
  for (const f of fetched) {
    for (let d = 0; d < 7; d++) {
      rows.push({
        venue_id: f.venue.id,
        day_int: d,
        day_text: DAY_TEXT[d],
        hour_data: f.week.slice(d * 24, (d + 1) * 24),
        fetched_at: now,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await supabase
      .from("venue_typical_hours")
      .upsert(chunk, { onConflict: "venue_id,day_int" });
    if (error) throw new FatalError(`upsert failed at chunk ${i / 500}: ${error.message}`);
  }
  console.log(`Upserted ${rows.length} rows for ${fetched.length} venues.`);
  console.log("Synced venues:", fetched.slice(0, 20).map((f) => `${f.venue.name} (${f.venue.city})`).join("; ") + (fetched.length > 20 ? " ..." : ""));
}

main().catch((err) => {
  console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err);
  process.exit(1);
});
