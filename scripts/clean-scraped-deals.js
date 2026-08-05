// One-off cleanup for AUTO-CRAWLED "Happy Hour" deal blurbs. The monthly crawl
// stored a raw text window around the "happy hour" keyword as `detail`, which
// dragged in page nav ("Open Menu Close Menu…"), boilerplate, and even venue
// addresses — making deal tiles too long and messy. This re-runs the current
// cleanDetail() logic over each and either tightens it or, when there's no real
// offer left, nulls it (tile then shows just the clean "Happy Hour" title).
//
// SCOPE: only rows whose detail is actually JUNKY — too long (>120), containing
// page chrome ("Open Menu"…), or an address/zip/phone. The hand-curated
// reviewed-deals (also source='scraped', short clean sentences, sometimes even
// titled "Happy Hour") are already tidy and are left completely untouched.
//
// DRY RUN by default — prints a before/after diff. Pass --write to apply.
// Usage: railway variables --json | node scripts/clean-scraped-deals.js [--write]
const { createClient } = require("@supabase/supabase-js");
const { cleanDetail } = require("../src/util/dealText");

const WRITE = process.argv.includes("--write");

// Only these rows get rewritten — the raw auto-crawled window artifacts.
const CHROME = /open menu|close menu|skip to content|reservations|about us|gallery|careers|contact us|order online|book a show|our beers|merch store|private (?:events?|dining)/i;
const ADDRESSY = /\b(?:NC|SC|GA|TN|FL|PA|NY|MD|MA|VA|DC)\s*\d{5}\b|\b\d{2,5}\s+(?:[NSEW]\.?\s+)?[A-Z][a-zA-Z.]+\s+(?:st|ave|rd|blvd|dr|ln|way|hwy|pkwy|ct|street|avenue|road|drive)\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/i;
const isJunky = (d) => d.length > 120 || CHROME.test(d) || ADDRESSY.test(d);

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = ""; process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

  const { data: rows, error } = await supabase.from("deals")
    .select("id, title, detail").eq("source", "scraped").not("detail", "is", null);
  if (error) throw new Error(error.message);

  let changed = 0, nulled = 0, unchanged = 0, skippedClean = 0;
  const updates = [];
  for (const d of rows) {
    if (!isJunky(d.detail)) { skippedClean++; continue; } // already tidy — leave it
    const next = cleanDetail(d.detail);
    if (next === d.detail) { unchanged++; continue; }
    updates.push({ id: d.id, detail: next });
    if (next === null) nulled++; else changed++;
    if (changed + nulled <= 30) {
      console.log(`\n[${next === null ? "NULL" : "TRIM"}] ${d.title}`);
      console.log(`  was: ${d.detail.slice(0, 140)}`);
      console.log(`  now: ${next === null ? "(cleared — tile shows title only)" : next}`);
    }
  }

  console.log(`\n${rows.length} scraped deals with detail → ${changed} tightened, ${nulled} cleared, ${unchanged} junky-but-unchanged, ${skippedClean} already tidy (skipped).`);
  if (!WRITE) { console.log("DRY RUN — pass --write to apply."); return; }

  let done = 0;
  for (const u of updates) {
    const { error: e } = await supabase.from("deals").update({ detail: u.detail }).eq("id", u.id);
    if (e) console.warn(`  fail ${u.id}: ${e.message}`); else done++;
  }
  console.log(`Applied ${done}/${updates.length} updates.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
