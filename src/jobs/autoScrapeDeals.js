// Weekly self-serve deal coverage. Crawls venues added in the last 8 days
// that have a website and zero active deals, and auto-inserts ONLY the
// highest-confidence pattern: a "happy hour" mention with an explicit
// day-of-week signal AND a time window. Anything looser stays a manual
// curation job (scripts/curate-scraped-deals.js) — this cron exists so a new
// city or venue never sits deal-less because nobody re-ran the pipeline.
const { supabase } = require("../config/supabase");
const { assertPublicUrlAtFetch } = require("../util/safeUrl");
const { cleanDetail } = require("../util/dealText");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SOCIAL = /facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|linktr\.ee|untappd\.com/i;
const SPECIALS_LINK = /specials|happy-?hour|menu|deals|weekly/i;
const RECURRING_SENTINEL = "2099-01-01T00:00:00Z";
const DAY_WORDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function daysIn(text) {
  const days = new Set();
  const t = text.toLowerCase();
  for (const [word, n] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`every ${word}|${word}s\\b|\\b${word} nights?\\b`).test(t)) days.add(n);
  }
  if (/\bdaily\b|every ?day|7 days a week/.test(t)) for (let d = 0; d < 7; d++) days.add(d);
  if (/week ?days|mon ?(-|–|thru|through) ?fri/i.test(t)) for (const d of [1, 2, 3, 4, 5]) days.add(d);
  return [...days].sort();
}

function to24(h, m, ap, biasEvening) {
  h = Number(h); m = Number(m || 0);
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (!ap && biasEvening && h >= 1 && h <= 7) h += 12;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function windowIn(text) {
  const m = TIME_RE.exec(text);
  if (!m) return null;
  const apEnd = (m[6] || "").toLowerCase();
  const apStart = (m[3] || apEnd).toLowerCase();
  const start = to24(m[1], m[2], apStart, true);
  const end = to24(m[4], m[5], apEnd, true);
  return start === end ? null : { start, end };
}

function stripText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;|&\w+;/g, " ")
    .replace(/\s+/g, " ");
}

// SSRF-safe fetch: re-resolve + range-check the host on every hop (manual
// redirects) so neither DNS rebinding nor a 30x to an internal address slips
// through. Returns null on any unsafe/blocked/failed hop.
async function get(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let safeHref;
    try { safeHref = await assertPublicUrlAtFetch(current); } catch { return null; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(safeHref, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), safeHref).href; // validated on next loop
        continue;
      }
      if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return null;
      return { html: (await res.text()).slice(0, 1_000_000), finalUrl: res.url || safeHref };
    } catch { return null; } finally { clearTimeout(t); }
  }
  return null;
}

async function venueTexts(website) {
  const home = await get(website);
  if (!home) return [];
  const texts = [stripText(home.html)];
  const links = new Set();
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(home.html)) && links.size < 2) {
    const href = m[1];
    if (!SPECIALS_LINK.test(href) || SOCIAL.test(href) || /\.(pdf|jpg|png|webp)(\?|$)/i.test(href)) continue;
    try {
      const abs = new URL(href, home.finalUrl || website).href;
      if (new URL(abs).hostname === new URL(home.finalUrl || website).hostname) links.add(abs);
    } catch { /* bad href */ }
  }
  for (const link of links) {
    const sub = await get(link);
    if (sub) texts.push(stripText(sub.html));
  }
  return texts;
}

async function run() {
  const since = new Date(Date.now() - 8 * 86400000).toISOString();
  const { data: recent, error } = await supabase.from("venues")
    .select("id, name, city, website")
    .gte("created_at", since).not("website", "is", null).limit(150);
  if (error) throw new Error(error.message);
  if (!recent?.length) return { crawled: 0, inserted: 0 };

  const ids = recent.map((v) => v.id);
  const { data: existing } = await supabase.from("deals").select("venue_id").in("venue_id", ids).eq("is_active", true);
  const hasDeal = new Set((existing || []).map((r) => r.venue_id));
  const targets = recent.filter((v) => !hasDeal.has(v.id) && !SOCIAL.test(v.website));

  let crawled = 0, inserted = 0;
  const byCity = {}; // city -> deals inserted this run
  for (const v of targets) {
    crawled++;
    try {
      for (const text of await venueTexts(v.website)) {
        const idx = text.toLowerCase().indexOf("happy hour");
        if (idx === -1) continue;
        const snippet = text.slice(Math.max(0, idx - 140), idx + 180);
        const days = daysIn(snippet);
        const win = windowIn(snippet);
        if (!days.length || !win) continue;
        const { error: iErr } = await supabase.from("deals").insert({
          venue_id: v.id, title: "Happy Hour",
          detail: cleanDetail(text.slice(idx, idx + 220)),
          tags: ["Happy Hour"], expires_at: RECURRING_SENTINEL,
          recur_days: days, recur_start: win.start, recur_end: win.end,
          is_premium_only: false, source: "scraped", is_active: true,
        });
        if (!iErr) { inserted++; byCity[v.city] = (byCity[v.city] || 0) + 1; }
        break; // one auto-deal per venue max
      }
    } catch { /* venue site down — next */ }
    await delay(300);
  }
  await maybeEmail({ crawled, inserted, byCity });
  return { crawled, inserted };
}

// Notify on every run that actually checked new venues (crawled > 0), so a new
// city/venue getting auto-covered is visible. Silent when there were no new
// venues to check (nothing ran) to avoid weekly empty mail.
async function maybeEmail({ crawled, inserted, byCity }) {
  const to = process.env.CRAWL_REPORT_EMAIL || process.env.FOUNDER_EMAIL;
  if (!to || !process.env.RESEND_API_KEY || crawled === 0) {
    if (crawled > 0) console.log(`auto_scrape_deals: crawled ${crawled}, inserted ${inserted} (set CRAWL_REPORT_EMAIL/FOUNDER_EMAIL to email this).`);
    return;
  }
  const rows = Object.entries(byCity).sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<tr><td>${(c || "").replace(/</g, "&lt;")}</td><td align="right">+${n}</td></tr>`).join("")
    || `<tr><td colspan="2" style="color:#777">No new happy-hour deals matched this week.</td></tr>`;
  const html = `<div style="font-family:Georgia,serif;color:#1C1C1C"><h2>Roaman weekly deal top-up</h2>
    <p>Checked <strong>${crawled}</strong> newly-added venue(s) with no deals yet · auto-inserted <strong>${inserted}</strong> happy-hour deal(s).</p>
    <table border="1" cellpadding="5" style="border-collapse:collapse;font-size:13px"><tr style="background:#f4f1ea"><th align="left">City</th><th>Deals added</th></tr>${rows}</table>
    <p style="font-size:12px;color:#777;margin-top:16px">This weekly job only covers venues added in the last 8 days that had zero deals. The full deals+events crawl runs monthly.</p></div>`;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Roaman <noreply@roaman.app>", to: [to], subject: `Roaman weekly deal top-up: +${inserted} deals across ${Object.keys(byCity).length || 0} city(ies)`, html }),
    });
    if (!resp.ok) console.error(`auto_scrape_deals email failed: ${resp.status}`);
    else console.log(`auto_scrape_deals report emailed to ${to}.`);
  } catch (e) { console.error("auto_scrape_deals email failed:", e.message); }
}

module.exports = run;
