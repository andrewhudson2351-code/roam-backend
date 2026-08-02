// Harvest contact emails from unclaimed venues' websites for a claim-outreach
// campaign. We only have website+phone from Google, not email — this fills the
// gap by scraping mailto:/contact emails off each venue's own site (SSRF-safe).
// DRY RUN by default; --write upserts into venue_outreach.
//
// Usage: railway variables --json | node scripts/harvest-venue-emails.js --city Charlotte [--limit N] [--write]
const { createClient } = require("@supabase/supabase-js");
const { assertPublicUrlAtFetch } = require("../src/util/safeUrl");

const argVal = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const CITY = argVal("--city");
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const WRITE = process.argv.includes("--write");
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SOCIAL = /facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|linktr\.ee/i;
const CONTACT_LINK = /contact|about|reach|connect/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// Junk/vendor addresses that are never a venue's real inbox.
const BAD_EMAIL = /noreply|no-reply|example\.|sentry|wixpress|\.png|\.jpg|\.gif|\.webp|godaddy|squarespace|@sentry|@wix|@2x|core-js|@babel|placeholder|domain\.com|email\.com|yourdomain/i;
// Wrong-department prefixes — won't reach a decision-maker on claim outreach.
const WRONG_DEPT = /^(accessibility|press|media|feedback|guestservices?|jobs|careers?|recruit\w*|hr|legal|privacy|webmaster|postmaster|hostmaster|abuse)@/i;
// Personal providers a small venue might legitimately use as its main inbox.
const FREE_PROVIDER = /@(gmail|yahoo|hotmail|outlook|live|aol|icloud|proton|protonmail)\./i;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = ""; process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function get(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let safe; try { safe = await assertPublicUrlAtFetch(current); } catch { return null; }
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(safe, { headers: { "User-Agent": UA }, redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location"), safe).href; continue; }
      if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return null;
      return { html: (await res.text()).slice(0, 800_000), finalUrl: res.url || safe };
    } catch { return null; } finally { clearTimeout(t); }
  }
  return null;
}

// Only trust an email on the venue's OWN domain or a personal free provider.
// This drops corporate-parent / chain inboxes (a bar's own site but a
// marriott.com / restaurant-group address) that won't convert on cold
// outreach — precision over recall. Prefers a named person, then a generic
// same-domain box, then a free-provider address.
function pickEmail(html, siteHost) {
  const domain = (siteHost || "").replace(/^www\./, "").toLowerCase();
  const same = new Set(), free = new Set();
  let m; EMAIL_RE.lastIndex = 0;
  while ((m = EMAIL_RE.exec(html))) {
    const e = m[0].toLowerCase();
    if (BAD_EMAIL.test(e) || WRONG_DEPT.test(e)) continue;
    if (domain && e.endsWith("@" + domain)) same.add(e);
    else if (FREE_PROVIDER.test(e)) free.add(e);
  }
  const pick = (arr) => arr.find((e) => /^[a-z]+\.[a-z]+@/.test(e))
    || arr.find((e) => !/^(info|hello|contact|hi|team|admin|orders|reservations|events)@/.test(e))
    || arr[0];
  if (same.size) return pick([...same]);
  if (free.size) return [...free][0];
  return null;
}

async function main() {
  const env = (k) => process.env[k] || (globalThis.__env || {})[k];
  globalThis.__env = await readStdinEnv();
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  if (!CITY) throw new Error("--city is required");

  const { data: venues, error } = await supabase.from("venues")
    .select("id, name, website").eq("city", CITY).is("owner_id", null).not("website", "is", null);
  if (error) throw new Error(error.message);
  const { data: already } = await supabase.from("venue_outreach").select("venue_id");
  const done = new Set((already || []).map((r) => r.venue_id));
  const targets = venues.filter((v) => !done.has(v.id) && !SOCIAL.test(v.website)).slice(0, LIMIT);
  console.log(`${CITY}: ${venues.length} unclaimed w/ website | ${targets.length} to harvest (skipping ${done.size} already in outreach)\n`);

  let found = 0;
  const queue = [...targets];
  const rows = [];
  async function worker() {
    while (queue.length) {
      const v = queue.shift();
      let email = null, src = null;
      try {
        const home = await get(v.website);
        if (home) {
          const host = new URL(home.finalUrl || v.website).hostname;
          email = pickEmail(home.html, host); src = home.finalUrl;
          if (!email) {
            const re = /<a[^>]+href=["']([^"'#]+)["']/gi; let lm; const links = new Set();
            while ((lm = re.exec(home.html)) && links.size < 1) { if (CONTACT_LINK.test(lm[1]) && !SOCIAL.test(lm[1])) { try { links.add(new URL(lm[1], home.finalUrl).href); } catch {} } }
            for (const l of links) { const sub = await get(l); if (sub) { email = pickEmail(sub.html, host); if (email) { src = l; break; } } }
          }
        }
      } catch {}
      if (email) { found++; rows.push({ venue_id: v.id, email, source_url: src, status: "harvested" }); console.log(`  ✓ ${v.name} — ${email}`); }
      await delay(120);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));

  console.log(`\nFound emails for ${found}/${targets.length} venues.`);
  if (!WRITE) { console.log("DRY RUN — pass --write to store in venue_outreach."); return; }
  for (let i = 0; i < rows.length; i += 100) {
    const { error: e } = await supabase.from("venue_outreach").upsert(rows.slice(i, i + 100), { onConflict: "venue_id" });
    if (e) throw new Error(e.message);
  }
  console.log(`Stored ${rows.length} rows in venue_outreach.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
