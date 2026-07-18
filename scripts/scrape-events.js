// Crawl venue websites for event signals.
// - Extracts schema.org Event JSON-LD (machine-parseable, high confidence)
// - Follows likely event/specials links one level deep
// - Captures text snippets around recurring-event keywords for manual curation
// Read-only against the web; writes a JSON report, touches nothing in the DB.
//
// Usage: railway variables --json | node scrape-events.js --city Charlotte [--limit N]

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const CITY = argVal("--city") || "Charlotte";
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const OUT = path.join(__dirname, `scrape-report-${CITY.toLowerCase().replace(/\s+/g, "-")}.json`);

const SOCIAL = /facebook\.com|instagram\.com|twitter\.com|x\.com|tiktok\.com|linktr\.ee|untappd\.com|order\.toasttab|doordash|grubhub|ubereats/i;
const EVENT_LINK = /event|calendar|whats-?on|happening|entertainment|live-?music|specials|happy-?hour|weekly|schedule/i;
const KEYWORDS = [
  "trivia", "karaoke", "live music", "open mic", "happy hour", "bingo",
  "dj ", "comedy", "tasting", "ladies night", "college night", "industry night",
  "every monday", "every tuesday", "every wednesday", "every thursday", "every friday", "every saturday", "every sunday",
  "mondays", "tuesdays", "wednesdays", "thursdays", "fridays", "saturdays", "sundays",
];
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function get(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const type = res.headers.get("content-type") || "";
    if (!type.includes("html")) return { error: `non-html: ${type.slice(0, 40)}` };
    const html = await res.text();
    return { html: html.slice(0, 1_500_000), finalUrl: res.url };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message.slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

function extractJsonLd(html) {
  const events = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let parsed;
    try { parsed = JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " ")); } catch { continue; }
    const nodes = [];
    const walk = (n) => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (n && typeof n === "object") {
        nodes.push(n);
        if (n["@graph"]) walk(n["@graph"]);
      }
    };
    walk(parsed);
    for (const n of nodes) {
      const type = [].concat(n["@type"] || []).join(",");
      if (/Event/i.test(type)) {
        events.push({
          type,
          name: n.name,
          startDate: n.startDate,
          endDate: n.endDate,
          description: typeof n.description === "string" ? n.description.slice(0, 300) : undefined,
          image: typeof n.image === "string" ? n.image : Array.isArray(n.image) ? n.image[0] : n.image?.url,
          eventSchedule: n.eventSchedule,
        });
      }
    }
  }
  return events;
}

function stripText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#\d+;|&\w+;/g, " ")
    .replace(/\s+/g, " ");
}

function keywordSnippets(html) {
  const text = stripText(html);
  const lower = text.toLowerCase();
  const found = [];
  for (const kw of KEYWORDS) {
    const i = lower.indexOf(kw);
    if (i !== -1) found.push({ kw: kw.trim(), snippet: text.slice(Math.max(0, i - 130), i + 170).trim() });
  }
  return found;
}

function eventLinks(html, baseUrl) {
  const links = new Set();
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.size < 4) {
    const href = m[1];
    const label = stripText(m[2]);
    if (!EVENT_LINK.test(href) && !EVENT_LINK.test(label)) continue;
    if (SOCIAL.test(href) || /\.(pdf|jpg|png|webp)(\?|$)/i.test(href) || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    try {
      const abs = new URL(href, baseUrl).href;
      if (new URL(abs).hostname === new URL(baseUrl).hostname) links.add(abs);
    } catch {}
  }
  return [...links];
}

async function crawlVenue(v) {
  const out = { venue_id: v.id, name: v.name, website: v.website, neighborhood: v.neighborhood, jsonldEvents: [], pages: [] };
  if (SOCIAL.test(v.website)) { out.status = "social-only"; return out; }
  const home = await get(v.website);
  if (home.error) { out.status = `home-failed: ${home.error}`; return out; }
  out.status = "ok";
  out.jsonldEvents.push(...extractJsonLd(home.html));
  const homeKw = keywordSnippets(home.html);
  if (homeKw.length) out.pages.push({ url: home.finalUrl, keywords: homeKw });
  for (const link of eventLinks(home.html, home.finalUrl || v.website).slice(0, 3)) {
    const sub = await get(link);
    if (sub.error) continue;
    out.jsonldEvents.push(...extractJsonLd(sub.html));
    const kw = keywordSnippets(sub.html);
    if (kw.length) out.pages.push({ url: link, keywords: kw });
  }
  return out;
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const { data: venues, error } = await supabase
    .from("venues")
    .select("id, name, website, neighborhood")
    .eq("city", CITY)
    .not("website", "is", null)
    .order("name");
  if (error) throw new Error(error.message);
  const toRun = venues.slice(0, LIMIT);
  console.log(`${CITY}: ${venues.length} venues with websites | crawling ${toRun.length}`);

  const results = [];
  let done = 0;
  const queue = [...toRun];
  async function worker() {
    while (queue.length) {
      const v = queue.shift();
      try { results.push(await crawlVenue(v)); }
      catch (e) { results.push({ venue_id: v.id, name: v.name, website: v.website, status: `crashed: ${e.message.slice(0, 80)}`, jsonldEvents: [], pages: [] }); }
      done++;
      if (done % 25 === 0) console.log(`  ...${done}/${toRun.length}`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));

  results.sort((a, b) => (b.jsonldEvents.length - a.jsonldEvents.length) || (b.pages?.length || 0) - (a.pages?.length || 0));
  fs.writeFileSync(OUT, JSON.stringify(results, null, 1));

  const ok = results.filter(r => r.status === "ok").length;
  const social = results.filter(r => r.status === "social-only").length;
  const failedN = results.length - ok - social;
  const withLd = results.filter(r => r.jsonldEvents.length).length;
  const withKw = results.filter(r => r.pages?.some(p => p.keywords.length)).length;
  console.log(`\nCrawled ok: ${ok} | social-only: ${social} | failed: ${failedN}`);
  console.log(`With JSON-LD events: ${withLd} | with keyword signals: ${withKw}`);
  console.log(`Report: ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
