// Monthly all-cities crawl for deals + events.
//
// Reliability ("catch-up guard"): ensureMonthlyCrawl() is called on startup
// and once daily. It atomically CLAIMS the current month via a UNIQUE row in
// monthly_crawl_runs, so exactly one run happens per calendar month — the
// first time the app is up on/after the 1st. If the 1st is missed (redeploy,
// downtime), the daily/startup check self-heals within hours. A crashed
// "running" row older than 2h, or a "failed" row, is cleared and retried.
//
// Quality: STRICT auto-insert only —
//   deals  -> "happy hour" + a day-of-week + a time window (high confidence)
//   events -> schema.org Event JSON-LD with a future date (machine-readable)
// Everything fuzzier (keyword recurring events, offers without clear timing)
// goes to the run's `report` for manual review (and is emailed if
// CRAWL_REPORT_EMAIL is set).
const { supabase } = require("../config/supabase");
const { assertPublicUrlAtFetch } = require("../util/safeUrl");
const { cleanDetail } = require("../util/dealText");

const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const SOCIAL = /facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|linktr\.ee|untappd\.com|doordash|grubhub|ubereats/i;
const SUBPAGE_LINK = /specials|happy-?hour|menu|deals|weekly|events|calendar|whats-?on|happening/i;
const RECURRING_SENTINEL = "2099-01-01T00:00:00Z";
const DAY_WORDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const REPORT_KW = ["trivia", "karaoke", "live music", "open mic", "bingo", "comedy"];
const REPORT_MAX = 300;

const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

// Decode the common HTML entities that survive in JSON-LD name/description
// fields (they come straight from JSON, not through stripText).
function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&amp;/g, "&").replace(/&#0?39;|&#x27;|&apos;/gi, "'")
    .replace(/&quot;|&#34;/g, '"').replace(/&#0?38;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ").trim();
}

function stripText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;|&\w+;/g, " ")
    .replace(/\s+/g, " ");
}

// schema.org Event JSON-LD -> [{ name, startDate, endDate, description, image }]
function extractJsonLdEvents(html) {
  const events = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].replace(new RegExp("[\u0000-\u001f]+","g"), " ")); } catch { continue; }
    const nodes = [];
    const walk = (n) => { if (Array.isArray(n)) return n.forEach(walk); if (n && typeof n === "object") { nodes.push(n); if (n["@graph"]) walk(n["@graph"]); } };
    walk(parsed);
    for (const n of nodes) {
      const type = [].concat(n["@type"] || []).join(",");
      if (/Event/i.test(type) && n.name && n.startDate) {
        events.push({
          name: decodeEntities(String(n.name)).slice(0, 120),
          startDate: n.startDate,
          endDate: n.endDate,
          description: typeof n.description === "string" ? decodeEntities(n.description).slice(0, 300) : null,
          image: typeof n.image === "string" ? n.image : Array.isArray(n.image) ? n.image[0] : n.image?.url || null,
        });
      }
    }
  }
  return events;
}

// "2026-08-15T20:00:00-04:00" -> { date:"2026-08-15", start:"20:00", end:null }
function parseEventDate(startDate, endDate) {
  const g = (s) => {
    if (typeof s !== "string") return null;
    const dm = s.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!dm) return null;
    return { date: dm[1], time: dm[2] ? `${dm[2]}:${dm[3]}` : null };
  };
  const s = g(startDate);
  if (!s) return null;
  const e = g(endDate);
  return { date: s.date, start: s.time, end: e && e.date === s.date ? e.time : null };
}

// SSRF-safe fetch: re-resolve + range-check every hop (manual redirects).
async function get(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    let safeHref;
    try { safeHref = await assertPublicUrlAtFetch(current); } catch { return null; }
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(safeHref, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "manual", signal: ctrl.signal });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) { current = new URL(res.headers.get("location"), safeHref).href; continue; }
      if (!res.ok || !(res.headers.get("content-type") || "").includes("html")) return null;
      return { html: (await res.text()).slice(0, 1_200_000), finalUrl: res.url || safeHref };
    } catch { return null; } finally { clearTimeout(t); }
  }
  return null;
}

async function venuePages(website) {
  if (SOCIAL.test(website)) return [];
  const home = await get(website);
  if (!home) return [];
  const pages = [home.html];
  const candidates = new Set();
  const re = /<a[^>]+href=["']([^"'#]+)["']/gi;
  const base = home.finalUrl || website;
  let m;
  while ((m = re.exec(home.html))) {
    const href = m[1];
    if (!SUBPAGE_LINK.test(href) || SOCIAL.test(href) || /\.(pdf|jpg|png|webp)(\?|$)/i.test(href)) continue;
    try {
      const abs = new URL(href, base).href;
      if (new URL(abs).hostname === new URL(base).hostname) candidates.add(abs);
    } catch { /* bad href */ }
  }
  // Prefer specials/happy-hour/deals pages (that's where the offer lives) over
  // generic menu/events pages, then take up to 3 distinct sub-pages.
  const rank = (u) => (/special|happy-?hour|deal/i.test(u) ? 0 : 1);
  const picked = [...candidates].sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  for (const link of picked) { const sub = await get(link); if (sub) pages.push(sub.html); }
  return pages;
}

// Count current active deals + upcoming events per city (not just this run's
// inserts), merged with the run's inserts, so the report shows real coverage.
async function buildCityStats(cities, cityVenueIds, perCity, todayStr) {
  const insertsOf = Object.fromEntries(perCity.map(c => [c.city, c]));
  const stats = [];
  for (const city of cities) {
    const ids = cityVenueIds[city] || [];
    let deals = 0, events = 0;
    for (let i = 0; i < ids.length; i += 150) {
      const chunk = ids.slice(i, i + 150);
      const [{ count: dc }, { count: ec }] = await Promise.all([
        supabase.from("deals").select("id", { count: "exact", head: true }).in("venue_id", chunk).eq("is_active", true),
        supabase.from("events").select("id", { count: "exact", head: true }).in("venue_id", chunk).eq("is_active", true).gte("event_date", todayStr),
      ]);
      deals += dc || 0; events += ec || 0;
    }
    const ins = insertsOf[city] || { dealsInserted: 0, eventsInserted: 0 };
    stats.push({ city, totalDeals: deals, totalEvents: events, dealsInserted: ins.dealsInserted, eventsInserted: ins.eventsInserted });
  }
  return stats.sort((a, b) => b.totalDeals - a.totalDeals);
}

async function maybeEmailReport(mk, summary) {
  // Send to CRAWL_REPORT_EMAIL, falling back to FOUNDER_EMAIL so a single
  // founder address covers all internal digests.
  const to = process.env.CRAWL_REPORT_EMAIL || process.env.FOUNDER_EMAIL;
  if (!to || !process.env.RESEND_API_KEY) {
    console.log(`monthly_crawl report for ${mk} stored on monthly_crawl_runs (set CRAWL_REPORT_EMAIL or FOUNDER_EMAIL + RESEND_API_KEY to have it emailed).`);
    return;
  }
  const stats = summary.cityStats || [];
  const gTotDeals = stats.reduce((s, c) => s + c.totalDeals, 0);
  const gTotEvents = stats.reduce((s, c) => s + c.totalEvents, 0);
  const cityRows = stats.map(c =>
    `<tr><td>${(c.city || "").replace(/</g, "&lt;")}</td>` +
    `<td align="right">${c.totalDeals}</td><td align="right" style="color:#2e7d32">${c.dealsInserted ? "+" + c.dealsInserted : "—"}</td>` +
    `<td align="right">${c.totalEvents}</td><td align="right" style="color:#2e7d32">${c.eventsInserted ? "+" + c.eventsInserted : "—"}</td></tr>`).join("");
  const rows = summary.report.slice(0, 80).map(r =>
    `<tr><td>${r.type}</td><td>${(r.venue || "").replace(/</g, "&lt;")}</td><td>${r.city}</td><td>${(r.kw || "")}</td><td>${(r.snippet || "").replace(/</g, "&lt;").slice(0, 140)}</td></tr>`).join("");
  const html = `<div style="font-family:Georgia,serif;color:#1C1C1C"><h2>Roaman monthly crawl — ${mk}</h2>
    <p><strong>Cities crawled:</strong> ${summary.citiesCrawled} · <strong>This run:</strong> +${summary.dealsInserted} deals, +${summary.eventsInserted} events.</p>
    <h3 style="margin-bottom:6px">Coverage by city <span style="font-weight:normal;font-size:12px;color:#777">(live totals; green = added this run)</span></h3>
    <table border="1" cellpadding="5" style="border-collapse:collapse;font-size:13px">
      <tr style="background:#f4f1ea"><th align="left">City</th><th>Deals</th><th>+new</th><th>Events</th><th>+new</th></tr>
      ${cityRows}
      <tr style="font-weight:bold;background:#f4f1ea"><td>All cities</td><td align="right">${gTotDeals}</td><td align="right">+${summary.dealsInserted}</td><td align="right">${gTotEvents}</td><td align="right">+${summary.eventsInserted}</td></tr>
    </table>
    <p style="margin-top:20px">${summary.report.length} borderline candidate(s) for review${summary.report.length > 80 ? " (showing first 80)" : ""}:</p>
    <table border="1" cellpadding="4" style="border-collapse:collapse;font-size:12px"><tr><th>type</th><th>venue</th><th>city</th><th>kw</th><th>snippet</th></tr>${rows}</table></div>`;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Roaman <noreply@roaman.app>", to: [to], subject: `Roaman monthly crawl — ${mk}: ${gTotDeals} deals, ${gTotEvents} events`, html }),
    });
    if (!resp.ok) console.error(`monthly_crawl report email failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    else console.log(`monthly_crawl report emailed to ${to}.`);
  } catch (e) { console.error("monthly_crawl report email failed:", e.message); }
}

// Crawl a SET of venues: insert future-dated JSON-LD events + strict
// happy-hour deals, and push borderline candidates to `report` (day-specific
// specials, recurring-event keywords). Dedupes against existing deals/events at
// these venues. Returns this run's insert counts. Shared by the monthly cron
// (called per city) and scripts/deep-crawl.js (called for a cluster).
async function crawlVenueSet(venues, { todayStr, report = null, reportMax = REPORT_MAX, concurrency = 6 } = {}) {
  let dealsInserted = 0, eventsInserted = 0;
  if (!venues?.length) return { dealsInserted, eventsInserted };

  // Dedupe against existing deals/events at these venues.
  const ids = venues.map(v => v.id);
  const dealKeys = new Set(), eventKeys = new Set();
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const [{ data: ds }, { data: es }] = await Promise.all([
      supabase.from("deals").select("venue_id, title").in("venue_id", chunk),
      supabase.from("events").select("venue_id, title, event_date").in("venue_id", chunk),
    ]);
    for (const d of ds || []) dealKeys.add(`${d.venue_id}|${(d.title || "").toLowerCase()}`);
    for (const e of es || []) eventKeys.add(`${e.venue_id}|${(e.title || "").toLowerCase()}|${e.event_date || ""}`);
  }

  const queue = [...venues];
  async function worker() {
    while (queue.length) {
      const v = queue.shift();
      try {
        for (const html of await venuePages(v.website)) {
          // EVENTS — schema.org JSON-LD, future-dated only (strict).
          for (const ev of extractJsonLdEvents(html)) {
            const p = parseEventDate(ev.startDate, ev.endDate);
            if (!p || p.date < todayStr) continue;
            const key = `${v.id}|${ev.name.toLowerCase()}|${p.date}`;
            if (eventKeys.has(key)) continue;
            eventKeys.add(key);
            const { error } = await supabase.from("events").insert({
              venue_id: v.id, title: ev.name, description: ev.description, cover_image_url: ev.image,
              tags: [], event_date: p.date, start_time: p.start, end_time: p.end, source: "scraped", is_active: true,
            });
            if (!error) eventsInserted++;
          }
          const text = stripText(html);
          const lower = text.toLowerCase();
          // DEALS — strict happy hour + day + window.
          const hi = lower.indexOf("happy hour");
          if (hi !== -1) {
            const snip = text.slice(Math.max(0, hi - 140), hi + 180);
            const days = daysIn(snip), win = windowIn(snip);
            const key = `${v.id}|happy hour`;
            if (days.length && win && !dealKeys.has(key)) {
              dealKeys.add(key);
              const { error } = await supabase.from("deals").insert({
                venue_id: v.id, title: "Happy Hour", detail: cleanDetail(text.slice(hi, hi + 220)),
                tags: ["Happy Hour"], expires_at: RECURRING_SENTINEL, recur_days: days, recur_start: win.start, recur_end: win.end,
                is_premium_only: false, source: "scraped", is_active: true,
              });
              if (!error) dealsInserted++;
            }
          }
          // REPORT — day-specific specials without a happy-hour label (e.g.
          // Duckworth's "$13.99 Fajitas Mondays"). Surface for manual review;
          // don't auto-insert — a bare day+price is indistinguishable from a
          // regular menu item, so a human decides.
          if (report && report.length < reportMax && hi === -1) {
            const dm = text.match(/[^.]{0,50}(?:\$\d{1,3}(?:\.\d{2})?|\d{1,2}\s*%\s*off|1\/2\s*off|half[\s-]?off|\bbogo\b)[^.]{0,50}/i);
            if (dm && daysIn(dm[0]).length) {
              report.push({ type: "day-special?", venue: v.name, city: v.city, kw: "special", snippet: dm[0].replace(/\s+/g, " ").trim().slice(0, 200) });
            }
          }
          // REPORT — recurring-event keywords with a day word (borderline).
          if (report && report.length < reportMax) {
            for (const kw of REPORT_KW) {
              const i = lower.indexOf(kw);
              if (i === -1) continue;
              const snip = text.slice(Math.max(0, i - 100), i + 150).replace(/\s+/g, " ").trim();
              if (daysIn(snip).length) { report.push({ type: "event?", venue: v.name, city: v.city, kw, snippet: snip.slice(0, 200) }); break; }
            }
          }
        }
      } catch { /* one venue down — continue */ }
      await delay(80);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { dealsInserted, eventsInserted };
}

async function runCrawl(runId) {
  const { data: cityRows } = await supabase.from("venues").select("city").not("website", "is", null);
  const cities = [...new Set((cityRows || []).map(c => c.city).filter(Boolean))];
  const todayStr = new Date().toISOString().slice(0, 10);
  let dealsInserted = 0, eventsInserted = 0, citiesCrawled = 0;
  const report = [];
  const perCity = [];         // this run's inserts, per city
  const cityVenueIds = {};    // city -> [venue ids], reused for end-of-run totals

  for (const city of cities) {
    const { data: venues } = await supabase.from("venues").select("id, name, city, website").eq("city", city).not("website", "is", null);
    if (!venues?.length) { citiesCrawled++; continue; }
    cityVenueIds[city] = venues.map(v => v.id);
    const { dealsInserted: cd, eventsInserted: ce } = await crawlVenueSet(venues, { todayStr, report });
    dealsInserted += cd; eventsInserted += ce;
    perCity.push({ city, dealsInserted: cd, eventsInserted: ce });
    citiesCrawled++;
  }

  // Current live totals per city (not just this run's inserts) so the report
  // lets you verify how much coverage each city actually has right now.
  const cityStats = await buildCityStats(cities, cityVenueIds, perCity, todayStr);

  const trimmed = report.slice(0, REPORT_MAX);
  await supabase.from("monthly_crawl_runs").update({
    status: "done", deals_inserted: dealsInserted, events_inserted: eventsInserted,
    cities_crawled: citiesCrawled, report: trimmed, finished_at: new Date().toISOString(),
  }).eq("id", runId);
  await maybeEmailReport(monthKey(), { dealsInserted, eventsInserted, citiesCrawled, report: trimmed, cityStats });
  console.log(`monthly_crawl done: cities ${citiesCrawled}, deals +${dealsInserted}, events +${eventsInserted}, report ${trimmed.length}`);
}

// Atomic once-per-month guard. Safe to call as often as you like.
async function ensureMonthlyCrawl() {
  const mk = monthKey();
  const { data: existing } = await supabase.from("monthly_crawl_runs").select("id, status, started_at").eq("run_month", mk).maybeSingle();
  if (existing) {
    if (existing.status === "done") return;
    const stale = new Date(existing.started_at).getTime() < Date.now() - 2 * 3600000;
    if (existing.status === "running" && !stale) return;       // a run is genuinely in progress
    await supabase.from("monthly_crawl_runs").delete().eq("id", existing.id); // crashed/failed — clear to retry
  }
  const { data, error } = await supabase.from("monthly_crawl_runs").insert({ run_month: mk, status: "running" }).select("id").single();
  if (error) return; // lost the race to a concurrent claim (unique violation) — fine
  try {
    await runCrawl(data.id);
  } catch (err) {
    console.error("monthly_crawl failed:", err);
    await supabase.from("monthly_crawl_runs").update({ status: "failed", finished_at: new Date().toISOString() }).eq("id", data.id);
  }
}

module.exports = { ensureMonthlyCrawl, buildCityStats, maybeEmailReport, crawlVenueSet };
