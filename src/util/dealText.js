// Build a short, clean deal blurb from scraped page text. The raw window can
// drag in page nav ("Open Menu Close Menu…") and boilerplate, so: start at the
// offer keyword, drop a leading bare "Happy Hour" label (the title already says
// it), require a real offer signal (else it's just page chrome → null so the
// tile shows only the clean title), cut common nav/boilerplate tails, strip
// address/phone/URL fragments, and cap at a word boundary. Used by the monthly
// crawl at insert time and by scripts/clean-scraped-deals.js for existing rows.
function cleanDetail(raw) {
  if (!raw) return null;
  let s = String(raw).replace(/\s+/g, " ").trim();
  const i = s.toLowerCase().indexOf("happy hour");
  if (i > 0) s = s.slice(i);
  s = s.replace(/^happy\s*hours?[\s:|,\-–—]*/i, "");
  const hasOffer = /(\d\s*[-–—]\s*\d|\d\s*[:.]?\d*\s*[ap]\.?m|\$\s*\d|\d+\s*%|half[\s-]?off|1\/2\s*off|\boff\b|\bfree\b|\bbogo\b|2\s*for\s*\$?\d)/i.test(s);
  if (!hasOffer) return null;
  s = s.split(/\b(?:view event|open menu|close menu|skip to content|reservations?|gift cards?|private (?:events?|dining)|follow follow|order online|book a|our beers|merch store)\b/i)[0];
  s = s
    .replace(/\b\d{2,5}\s+(?:[NSEW]\.?\s+)?[A-Z][a-zA-Z.]+(?:\s+[A-Z][a-zA-Z.]+){0,3}\s+(?:st|ave|rd|blvd|dr|ln|way|hwy|pkwy|ct|street|avenue|road|drive)\b\.?/gi, " ")
    .replace(/\b(?:NC|SC|GA|TN|FL|PA|NY|MD|MA|VA|DC)\s*\d{5}\b/gi, " ")
    .replace(/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g, " ")
    .replace(/(?:www\.\S+|https?:\/\/\S+)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 100) s = s.slice(0, 100).replace(/\s+\S*$/, "").trim() + "…";
  s = s.replace(/^[\s:|,\-–—]+|[\s:|,.\-–—]+$/g, "").trim();
  return s.length >= 4 ? s : null;
}

module.exports = { cleanDetail };
