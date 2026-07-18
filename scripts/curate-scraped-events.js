// Curate scrape-report-charlotte.json (JSON-LD events) into events rows.
// - keeps only future events within 60 days (or active weekly recurrences)
// - collapses >=3 same-name/same-time weekday instances into recurring events
// - filters cross-venue contamination from shared corporate feeds
// - inserts with source='scraped', is_active=false (nothing goes live until reviewed)
//
// Usage:
//   railway variables --json | node scripts/curate-scraped-events.js --dry
//   railway variables --json | node scripts/curate-scraped-events.js

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY = process.argv.includes("--dry");
const REPORT = path.join(__dirname, "scrape-report-charlotte.json");
const HORIZON_DAYS = 60;
const MAX_PER_VENUE = 10;

// junk duplicate rows — events go to the clean sibling (Petra's Piano Bar, Tequila House)
const SKIP_VENUE_IDS = new Set([
  "5b6d9f19-fe7b-47c0-8465-5d858d64d630", // "Petra's"
  "8f0421f5-93f0-4e74-84a6-992dd78dba09", // "Tequila House Nightclub"
]);
const EXTERNAL_RE = /greensboro|tassels|the pony/i;
// "closed" placeholders, cancellations, and events we can't attribute to one venue
const EXCLUDE_TITLE_RE = /^closed$|cancell?ed|bikini car wash/i;

const TAG_RULES = [
  [/karaoke/i, "Karaoke"],
  [/trivia/i, "Trivia"],
  [/comedy|stand-?up/i, "Comedy"],
  [/\bdj\b|club night/i, "DJ Set"],
  [/live music|band|jazz|concert|\btour\b|open mic|acoustic|jams/i, "Live Music"],
  [/brunch/i, "Brunch"],
  [/happy hour|golden hour/i, "Happy Hour"],
  [/tasting|pairing/i, "Tasting"],
  [/ladies night/i, "Ladies Night"],
  [/wine/i, "Wine"],
  [/beer|brew/i, "Beer"],
  [/cocktail/i, "Cocktails"],
  [/game ?day|football|watch party/i, "Sports"],
];

function decode(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ").replace(/&#x27;|&apos;/g, "'")
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

// wall-clock as written; venue feeds mislabel timezones constantly
function parseLocal(s) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(s || ""));
  if (!m) return null;
  return { date: m[1], time: m[2] ? `${m[2]}:${m[3]}` : null };
}

function addDaysStr(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOf(dateStr) { return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); }
function addHours(t, h) {
  const [hh, mm] = t.split(":").map(Number);
  return `${String((hh + h) % 24).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function inferTags(text, title, venueName) {
  const tags = [];
  for (const [re, tag] of TAG_RULES) if (re.test(text) && !tags.includes(tag)) tags.push(tag);
  // pipe-separated titles are band lineups ("Mandako | Iris Blue | STEV")
  if (!tags.length && /\s\|\s/.test(title)) tags.push("Live Music");
  // comedians' names carry no keywords — trust the venue ("The Comedy Zone")
  if (!tags.length && /comedy/i.test(venueName || "")) tags.push("Comedy");
  return tags.length ? tags.slice(0, 3) : ["Theme Night"];
}

// shared corporate feeds list sister venues' events — keep only this venue's
function belongsToVenue(eventName, venueName, location) {
  const n = eventName.toLowerCase();
  const v = venueName.toLowerCase();
  if (EXTERNAL_RE.test(n)) return false;
  if (location) {
    const l = location.toLowerCase();
    if (!l.includes(v) && !v.includes(l)) return false;
  }
  for (const brand of ["gentlemen", "gold club", "leather"]) {
    if (n.includes(brand) && !v.includes(brand)) return false;
  }
  const dtr = /dtr (southpark|plaza midwood|dilworth)/i.exec(eventName);
  if (dtr) return v.includes(`dtr ${dtr[1].toLowerCase()}`);
  if (v.startsWith("dtr ")) return v === "dtr dilworth"; // unqualified DTR events -> original location
  return true;
}

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

function todayCharlotte() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const today = todayCharlotte();
  const horizon = addDaysStr(today, HORIZON_DAYS);
  const rows = [];

  for (const v of report) {
    if (!v.jsonldEvents?.length || SKIP_VENUE_IDS.has(v.venue_id)) continue;

    // normalize + filter
    const seen = new Set();
    const cleaned = [];
    for (const e of v.jsonldEvents) {
      const name = decode(e.name);
      if (!name || EXCLUDE_TITLE_RE.test(name)) continue;
      if (!belongsToVenue(name, v.name, e.location)) continue;
      const start = parseLocal(e.startDate);
      if (!start || !start.time) continue; // no invented times for date-only feeds
      const endParsed = parseLocal(e.endDate);
      if (start.time === "00:00" && endParsed?.time === "23:59") continue; // fake all-day window, feed has no real times
      let endTime = endParsed?.time && endParsed.time !== start.time ? endParsed.time : addHours(start.time, 3);
      const key = `${name.toLowerCase()}|${start.date}|${start.time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push({
        name, date: start.date, time: start.time, endTime,
        description: decode(e.description) || null,
        image: typeof e.image === "string" && /^https?:/.test(e.image) ? e.image : null,
      });
    }

    // collapse weekly recurrences: same name + times, >=3 instances, still active
    const groups = new Map();
    for (const e of cleaned) {
      const k = `${e.name.toLowerCase()}|${e.time}|${e.endTime}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }

    const venueRows = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a.date.localeCompare(b.date));
      const last = group[group.length - 1];
      const days = [...new Set(group.map(e => weekdayOf(e.date)))].sort();
      const spanDays = (new Date(last.date) - new Date(group[0].date)) / 86400000;
      const isRecurring = group.length >= 3 && days.length <= 2 && spanDays >= 14 && last.date >= addDaysStr(today, -7);
      if (isRecurring) {
        venueRows.push({
          venue_id: v.venue_id, venueName: v.name,
          title: group[0].name, description: group[0].description, cover_image_url: group[0].image,
          tags: inferTags(`${group[0].name} ${group[0].description || ""}`, group[0].name, v.name),
          event_date: null, start_time: null, end_time: null,
          recur_days: days, recur_start: group[0].time, recur_end: group[0].endTime,
          // feeds only publish a few weeks out — a series still running today is treated as ongoing
          recur_until: last.date >= today ? null : last.date,
          source: "scraped", is_active: false,
          _sort: group.find(e => e.date >= today)?.date || last.date, _kind: "recurring",
        });
      } else {
        for (const e of group) {
          if (e.date < today || e.date > horizon) continue;
          venueRows.push({
            venue_id: v.venue_id, venueName: v.name,
            title: e.name, description: e.description, cover_image_url: e.image,
            tags: inferTags(`${e.name} ${e.description || ""}`, e.name, v.name),
            event_date: e.date, start_time: e.time, end_time: e.endTime,
            recur_days: null, recur_start: null, recur_end: null, recur_until: null,
            source: "scraped", is_active: false,
            _sort: e.date, _kind: "one-time",
          });
        }
      }
    }
    venueRows.sort((a, b) => (a._kind === "recurring" ? -1 : 1) - (b._kind === "recurring" ? -1 : 1) || a._sort.localeCompare(b._sort));
    rows.push(...venueRows.slice(0, MAX_PER_VENUE));
  }

  const byVenue = new Map();
  for (const r of rows) {
    if (!byVenue.has(r.venueName)) byVenue.set(r.venueName, []);
    byVenue.get(r.venueName).push(r);
  }
  console.log(`Curated ${rows.length} events across ${byVenue.size} venues (as of ${today})\n`);
  for (const [venue, list] of byVenue) {
    console.log(`## ${venue} (${list.length})`);
    for (const r of list) {
      const sched = r.event_date
        ? `${r.event_date} ${r.start_time}-${r.end_time}`
        : `weekly [${r.recur_days.join(",")}] ${r.recur_start}-${r.recur_end}${r.recur_until ? ` until ${r.recur_until}` : ""}`;
      console.log(`   - ${r.title} | ${sched} | ${r.tags.join(", ")}`);
    }
  }

  if (DRY) { console.log("\nDRY RUN — nothing inserted."); return; }

  const clean = rows.map(({ venueName, _sort, _kind, ...r }) => r);
  for (let i = 0; i < clean.length; i += 50) {
    const { error } = await supabase.from("events").insert(clean.slice(i, i + 50));
    if (error) throw new Error(`insert failed at chunk ${i}: ${error.message}`);
  }
  console.log(`\nInserted ${clean.length} events (source='scraped', is_active=false).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
