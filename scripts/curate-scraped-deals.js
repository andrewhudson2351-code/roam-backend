// Extract recurring specials/happy-hour deals from the scrape-report keyword
// snippets and insert them with source='scraped' (display-only in the app —
// the redeem route rejects scraped deals).
// Conservative: only emits when a snippet has a day-of-week signal AND a
// concrete offer (price, half-price/BOGO/2-for-1, or a timed happy hour).
//
// Usage: railway variables --json | node curate-scraped-deals.js --city Charlotte [--dry|--activate]

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const args = process.argv.slice(2);
const argVal = (f) => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };
const CITY = argVal("--city") || "Charlotte";
const DRY = !args.includes("--activate");
const REPORT = path.join(__dirname, `scrape-report-${CITY.toLowerCase().replace(/\s+/g, "-")}.json`);

const RECURRING_SENTINEL = "2099-01-01T00:00:00Z";
const MAX_PER_VENUE = 4;

// venueName|titleLower — reviewed and rejected during dry runs
const SKIP = new Set([]);

const DAY_WORDS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const OFFER_RE = /\$\s?\d+(?:\.\d\d)?\s+(?:[a-z'&-]+ ?){1,5}|half[- ]?priced?\s+(?:[a-z'&-]+ ?){1,4}|\b(?:2|two)[- ]for[- ](?:1|one)\b[^.!]{0,40}|\bbogo\b[^.!]{0,40}|\d\d?% off\s+(?:[a-z'&-]+ ?){1,4}/i;
const TIME_RE = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;

function daysIn(text) {
  const days = new Set();
  const t = text.toLowerCase();
  for (const [word, n] of Object.entries(DAY_WORDS)) {
    if (new RegExp(`every ${word}|${word}s\\b|\\b${word} nights?\\b`).test(t)) days.add(n);
  }
  if (/\bdaily\b|every ?day|7 days a week/.test(t)) for (let d = 0; d < 7; d++) days.add(d);
  if (/happy hour/.test(t) && !days.size && /week ?days|mon ?(-|–|thru|through) ?fri/i.test(t)) for (const d of [1, 2, 3, 4, 5]) days.add(d);
  return [...days].sort();
}

function to24(h, m, ap, biasEvening) {
  h = Number(h); m = Number(m || 0);
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  // no am/pm: bar context — 1-7 means evening
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
  if (start === end) return null;
  return { start, end };
}

function titleFrom(text) {
  const m = OFFER_RE.exec(text);
  if (!m) return null;
  let t = m[0].replace(/\s+/g, " ").trim().replace(/[,;:.\s]+$/, "");
  // title-case-ish: keep $ amounts, capitalize words
  t = t.split(" ").map((w) => (/^\$|^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
  return t.length >= 6 && t.length <= 60 ? t : null;
}

function inferTags(text) {
  const t = text.toLowerCase();
  const tags = [];
  const add = (tag) => { if (!tags.includes(tag) && tags.length < 3) tags.push(tag); };
  if (/happy hour/.test(t)) add("Happy Hour");
  if (/\bwings?\b/.test(t)) add("Wings");
  if (/\btacos?\b/.test(t)) add("Tacos");
  if (/brunch|mimosa|bloody mar/.test(t)) add("Brunch");
  if (/pizza/.test(t)) add("Pizza");
  if (/\bbeers?\b|draft|pint|ipa|lager/.test(t)) add("Beer");
  if (/cocktail|martini|margarita|old fashioned|spritz/.test(t)) add("Cocktails");
  if (/\bwines?\b|bottle service/.test(t)) add("Wine");
  if (/\bshots?\b/.test(t)) add("Shots");
  if (/trivia|quizzo/.test(t)) add("Trivia");
  if (/karaoke/.test(t)) add("Karaoke");
  if (/ladies night/.test(t)) add("Ladies Night");
  if (!tags.length) add("Apps/Small Plates");
  return tags;
}

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

// --input mode: insert a hand-reviewed JSON list instead of raw extraction.
// [{ venueName, title, detail, tags, recur_days, recur_start, recur_end, expires_at? }]
async function insertReviewed(supabase, file) {
  const list = JSON.parse(fs.readFileSync(file, "utf8"));
  const names = [...new Set(list.map((d) => d.venueName))];
  const { data: venues, error } = await supabase.from("venues").select("id, name").eq("city", CITY).in("name", names);
  if (error) throw new Error(error.message);
  const byName = new Map(venues.map((v) => [v.name, v.id]));
  const missing = names.filter((n) => !byName.has(n));
  if (missing.length) throw new Error(`venues not found in ${CITY}: ${missing.join(" | ")}`);

  const { data: existingDeals, error: eErr } = await supabase.from("deals").select("venue_id, title").in("venue_id", [...byName.values()]);
  if (eErr) throw new Error(eErr.message);
  const existing = new Set(existingDeals.map((d) => `${d.venue_id}|${d.title.toLowerCase()}`));

  const rows = list
    .map((d) => ({
      venue_id: byName.get(d.venueName),
      title: d.title,
      description: null,
      detail: d.detail || null,
      tags: d.tags,
      expires_at: d.expires_at || RECURRING_SENTINEL,
      recur_days: d.recur_days,
      recur_start: d.recur_start,
      recur_end: d.recur_end,
      is_premium_only: false,
      source: "scraped",
      is_active: true,
    }))
    .filter((r) => !existing.has(`${r.venue_id}|${r.title.toLowerCase()}`));
  console.log(`${list.length} reviewed deals, ${rows.length} new`);
  if (DRY) { console.log("DRY RUN — nothing inserted."); return; }
  if (rows.length) {
    const { error: iErr } = await supabase.from("deals").insert(rows);
    if (iErr) throw new Error(iErr.message);
  }
  console.log(`Inserted ${rows.length} deals (source='scraped', is_active=true).`);
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  const inputFile = argVal("--input");
  if (inputFile) return insertReviewed(supabase, inputFile);
  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));

  // identical snippets appearing under multiple venues = shared corporate feed;
  // attribution is unreliable, so flag them for manual review
  const snippetOwners = new Map();
  for (const v of report) {
    for (const p of v.pages || []) for (const k of p.keywords || []) {
      const key = k.snippet.slice(0, 120);
      if (!snippetOwners.has(key)) snippetOwners.set(key, new Set());
      snippetOwners.get(key).add(v.name);
    }
  }

  const rows = [];
  for (const v of report) {
    const seen = new Set();
    const candidates = [];
    for (const p of v.pages || []) {
      for (const k of p.keywords || []) {
        const text = k.snippet;
        const days = daysIn(text);
        if (!days.length) continue;
        const isHappyHour = /happy hour/i.test(text);
        const title = titleFrom(text) || (isHappyHour ? "Happy Hour" : null);
        if (!title) continue;
        const win = windowIn(text);
        if (isHappyHour && !win) continue; // untimed "happy hour" mentions are too vague
        const shared = snippetOwners.get(text.slice(0, 120)).size;
        const dkey = title.toLowerCase();
        if (seen.has(dkey) || SKIP.has(`${v.name}|${dkey}`)) continue;
        seen.add(dkey);
        candidates.push({
          venue_id: v.venue_id, venueName: v.name, shared,
          title,
          description: null,
          detail: text.replace(/\s+/g, " ").trim().slice(0, 180),
          tags: inferTags(`${title} ${text}`),
          expires_at: RECURRING_SENTINEL,
          recur_days: days,
          recur_start: win ? win.start : "00:00",
          recur_end: win ? win.end : "23:59",
          is_premium_only: false,
          source: "scraped", is_active: true,
        });
      }
    }
    rows.push(...candidates.slice(0, MAX_PER_VENUE));
  }

  // skip deals already inserted (re-runs) — match on venue_id + title
  const venueIds = [...new Set(rows.map((r) => r.venue_id))];
  const existing = new Set();
  for (let i = 0; i < venueIds.length; i += 50) {
    const { data, error } = await supabase.from("deals").select("venue_id, title").in("venue_id", venueIds.slice(i, i + 50));
    if (error) throw new Error(`existing-deals check failed: ${error.message}`);
    for (const d of data) existing.add(`${d.venue_id}|${d.title.toLowerCase()}`);
  }
  const fresh = rows.filter((r) => !existing.has(`${r.venue_id}|${r.title.toLowerCase()}`));
  if (fresh.length < rows.length) console.log(`Skipping ${rows.length - fresh.length} deals already in the DB.\n`);

  console.log(`Curated ${fresh.length} candidate deals in ${CITY}\n`);
  const DAY_ABBR = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  for (const r of fresh) {
    const days = r.recur_days.map((d) => DAY_ABBR[d]).join(",");
    const sharedNote = r.shared > 1 ? `  [SHARED FEED x${r.shared}]` : "";
    console.log(`## ${r.venueName}${sharedNote}`);
    console.log(`   ${r.title} | [${days}] ${r.recur_start}-${r.recur_end} | ${r.tags.join(", ")}`);
    console.log(`   ctx: ${r.detail.slice(0, 150)}`);
  }

  if (DRY) { console.log("\nDRY RUN — nothing inserted."); return; }
  const clean = fresh.map(({ venueName, shared, ...r }) => r);
  for (let i = 0; i < clean.length; i += 50) {
    const { error } = await supabase.from("deals").insert(clean.slice(i, i + 50));
    if (error) throw new Error(`insert failed at chunk ${i}: ${error.message}`);
  }
  console.log(`\nInserted ${clean.length} deals (source='scraped', is_active=true).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
