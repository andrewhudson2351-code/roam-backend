// Curate scrape-report-charlotte.json (JSON-LD events) into events rows.
// - keeps only future events within 60 days (or active weekly recurrences)
// - collapses >=3 same-name/same-time weekday instances into recurring events
// - filters cross-venue contamination from shared corporate feeds
// - inserts with source='scraped', is_active=false (nothing goes live until reviewed)
//
// Usage:
//   railway variables --json | node scripts/curate-scraped-events.js --city Boston --dry
//   railway variables --json | node scripts/curate-scraped-events.js --city Boston --activate

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY = process.argv.includes("--dry");
const ACTIVATE = process.argv.includes("--activate");
const cityArgIdx = process.argv.indexOf("--city");
const CITY = cityArgIdx !== -1 ? process.argv[cityArgIdx + 1] : "Charlotte";
const REPORT = path.join(__dirname, `scrape-report-${CITY.toLowerCase().replace(/\s+/g, "-")}.json`);
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../src/config/timezones");
const HORIZON_DAYS = 60;
const MAX_PER_VENUE = 10;

// junk duplicate rows — events go to the clean sibling (Petra's Piano Bar, Tequila House)
const SKIP_VENUE_IDS = new Set([
  "5b6d9f19-fe7b-47c0-8465-5d858d64d630", // "Petra's"
  "8f0421f5-93f0-4e74-84a6-992dd78dba09", // "Tequila House Nightclub"
]);
const EXTERNAL_RE = /greensboro|tassels|the pony|albany|\btroy\b|saratoga arts|\bno fun\b/i;
// "closed" placeholders, cancellations, and events we can't attribute to one venue
const EXCLUDE_TITLE_RE = /^closed$|\bclosed$|cancell?ed|bikini car wash|private party/i;

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

// verified honest-UTC feeds; everyone else mislabels local time as UTC/Z, so literal parse is the default
const UTC_FEED_VENUES = new Set(["Chris' Jazz Cafe"]);

function utcToCity(s) {
  const d = new Date(s);
  if (isNaN(d)) return null;
  const tz = CITY_TIMEZONES[CITY] || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  return { date: `${g("year")}-${g("month")}-${g("day")}`, time: `${g("hour")}:${g("minute")}` };
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

function todayInCity() {
  const tz = CITY_TIMEZONES[CITY] || DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const normWeb = (s) => s.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");

// venues that share a website AND have near-identical names are duplicate DB rows;
// junk rows have a street address stored in `neighborhood` (e.g. "116 West 5th Street")
function detectDuplicates(report) {
  const skip = new Set();
  const byWeb = new Map();
  for (const v of report) {
    if (!v.website || SKIP_VENUE_IDS.has(v.venue_id)) continue;
    const k = normWeb(v.website);
    if (!byWeb.has(k)) byWeb.set(k, []);
    byWeb.get(k).push(v);
  }
  for (const group of byWeb.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const an = normName(a.name), bn = normName(b.name);
        if (!an.includes(bn) && !bn.includes(an)) continue;
        const junk = [a, b].filter((v) => /\d/.test(v.neighborhood || ""));
        const drop = junk.length === 1 ? junk[0] : (an.length >= bn.length ? b : a);
        skip.add(drop.venue_id);
        console.log(`DUPLICATE: skipping "${drop.name}" (${drop.venue_id}) — dup of "${(drop === a ? b : a).name}"`);
      }
    }
  }
  return skip;
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
  const today = todayInCity();
  const horizon = addDaysStr(today, HORIZON_DAYS);
  const dupSkip = detectDuplicates(report);
  const rows = [];

  for (const v of report) {
    if (!v.jsonldEvents?.length || SKIP_VENUE_IDS.has(v.venue_id) || dupSkip.has(v.venue_id)) continue;

    // normalize + filter
    const seen = new Set();
    const cleaned = [];
    for (const e of v.jsonldEvents) {
      const name = decode(e.name);
      if (!name || EXCLUDE_TITLE_RE.test(name)) continue;
      if (!belongsToVenue(name, v.name, e.location)) continue;
      const utcFeed = UTC_FEED_VENUES.has(v.name) && /Z$/.test(String(e.startDate || ""));
      const start = utcFeed ? utcToCity(e.startDate) : parseLocal(e.startDate);
      if (!start || !start.time) continue; // no invented times for date-only feeds
      const endParsed = utcFeed && e.endDate ? utcToCity(e.endDate) : parseLocal(e.endDate);
      // fake all-day window (00:00-23:59, sometimes offset-shifted e.g. 03:00-02:59) — feed has no real times
      if (endParsed?.time) {
        const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
        if ((mins(endParsed.time) - mins(start.time) + 1440) % 1440 >= 1380) continue;
      }
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
          source: "scraped", is_active: ACTIVATE,
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
            source: "scraped", is_active: ACTIVATE,
            _sort: e.date, _kind: "one-time",
          });
        }
      }
    }
    venueRows.sort((a, b) => (a._kind === "recurring" ? -1 : 1) - (b._kind === "recurring" ? -1 : 1) || a._sort.localeCompare(b._sort));
    rows.push(...venueRows.slice(0, MAX_PER_VENUE));
  }

  // skip events a previous curation run already inserted (re-crawls re-report them)
  const keyOf = (r) => `${r.venue_id}|${(r.title || "").toLowerCase()}|${r.event_date || "R"}`;
  const venueIds = [...new Set(rows.map((r) => r.venue_id))];
  const existingKeys = new Set();
  for (let i = 0; i < venueIds.length; i += 50) {
    const { data: ex, error: exErr } = await supabase
      .from("events")
      .select("venue_id, title, event_date")
      .eq("source", "scraped")
      .in("venue_id", venueIds.slice(i, i + 50));
    if (exErr) throw new Error(`existing-events check failed: ${exErr.message}`);
    for (const e of ex) existingKeys.add(keyOf(e));
  }
  const freshRows = rows.filter((r) => !existingKeys.has(keyOf(r)));
  if (freshRows.length < rows.length) console.log(`Skipping ${rows.length - freshRows.length} events already in the DB.\n`);

  const byVenue = new Map();
  for (const r of freshRows) {
    if (!byVenue.has(r.venueName)) byVenue.set(r.venueName, []);
    byVenue.get(r.venueName).push(r);
  }
  console.log(`Curated ${freshRows.length} new events across ${byVenue.size} ${CITY} venues (as of ${today})\n`);
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

  const clean = freshRows.map(({ venueName, _sort, _kind, ...r }) => r);
  for (let i = 0; i < clean.length; i += 50) {
    const { error } = await supabase.from("events").insert(clean.slice(i, i + 50));
    if (error) throw new Error(`insert failed at chunk ${i}: ${error.message}`);
  }
  console.log(`\nInserted ${clean.length} events (source='scraped', is_active=${ACTIVATE}).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
