// Backfill venues.instagram by extracting the venue's own Instagram profile
// link from its website homepage. Link extraction only — never touches
// Instagram itself. Only processes venues with a website and NULL instagram;
// safe to re-run.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Missing env vars are read from a JSON object piped to stdin (railway variables --json).
//
// Usage:
//   railway variables --json | node scripts/backfill-instagram.js [--city Charlotte] [--limit N]
//   node -r dotenv/config scripts/backfill-instagram.js

const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const argVal = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const CITY = argVal("--city");
const CONCURRENCY = 8;

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
// instagram.com path segments that are never profile handles
const NON_PROFILES = new Set(["p", "reel", "reels", "tv", "explore", "stories", "accounts", "share", "sharer", "hashtag", "invites", "about", "legal", "directory", "web", "developer"]);

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

function extractHandle(html) {
  const counts = new Map();
  for (const m of html.matchAll(/instagram\.com\/([A-Za-z0-9._]{2,30})/gi)) {
    const handle = m[1].replace(/\.+$/, "");
    if (NON_PROFILES.has(handle.toLowerCase())) continue;
    counts.set(handle, (counts.get(handle) || 0) + 1);
  }
  if (!counts.size) return null;
  // most-referenced handle wins (footers repeat the venue's own account)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

async function fetchHomepage(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return null;
    if (!(res.headers.get("content-type") || "").includes("html")) return null;
    return (await res.text()).slice(0, 1_500_000);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const SUPABASE_URL = env("SUPABASE_URL");
  const SUPABASE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new FatalError("Missing env: need SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  const venues = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("venues")
      .select("id, name, city, website")
      .not("website", "is", null)
      .is("instagram", null)
      .order("id")
      .range(from, from + 999);
    if (CITY) q = q.eq("city", CITY);
    const { data, error } = await q;
    if (error) throw new FatalError(`venues query failed: ${error.message}`);
    venues.push(...data);
    if (data.length < 1000) break;
  }
  const toRun = venues.slice(0, LIMIT);
  console.log(`Venues needing instagram${CITY ? ` in ${CITY}` : ""}: ${venues.length} | processing ${toRun.length}`);

  let updated = 0, none = 0, unreachable = 0, done = 0;
  const queue = [...toRun];
  async function worker() {
    for (;;) {
      const v = queue.shift();
      if (!v) return;
      const html = await fetchHomepage(v.website);
      if (!html) unreachable++;
      else {
        const handle = extractHandle(html);
        if (!handle) none++;
        else {
          const { error } = await supabase.from("venues").update({ instagram: handle }).eq("id", v.id);
          if (error) throw new FatalError(`update failed for ${v.name}: ${error.message}`);
          updated++;
        }
      }
      done++;
      if (done % 100 === 0) console.log(`  ...${done}/${toRun.length} (found ${updated}, none ${none}, unreachable ${unreachable})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log(`\nFound & saved: ${updated} | No IG link on site: ${none} | Site unreachable: ${unreachable}`);
}

main().catch((err) => {
  console.error(err instanceof FatalError ? `FATAL: ${err.message}` : err);
  process.exit(1);
});
