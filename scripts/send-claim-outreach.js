// Venue-claim outreach campaign sender. Emails unclaimed venues (harvested via
// harvest-venue-emails.js) inviting them to claim their live Roam page.
// CAN-SPAM compliant: real subject, physical address, working unsubscribe.
// DRY RUN by default — prints who would be emailed. Nothing sends without
// --send, and you should review the rendered copy first (--preview writes a
// sample .html). Never run --send without Drew's explicit go.
//
// Usage:
//   railway variables --json | node scripts/send-claim-outreach.js --city Charlotte           (dry run)
//   railway variables --json | node scripts/send-claim-outreach.js --city Charlotte --preview  (write sample HTML)
//   railway variables --json | node scripts/send-claim-outreach.js --city Charlotte --send [--limit N]
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");

const argVal = (f) => { const i = process.argv.indexOf(f); return i !== -1 ? process.argv[i + 1] : null; };
const CITY = argVal("--city");
const LIMIT = argVal("--limit") ? Number(argVal("--limit")) : Infinity;
const SEND = process.argv.includes("--send");
const PREVIEW = process.argv.includes("--preview");
const TEST_TO = argVal("--test"); // send ONE rendered sample to this address only; touches no venue records
const APP = "https://app.roaman.app";
const API = process.env.API_PUBLIC_URL || "https://roam-backend-production.up.railway.app";
// CAN-SPAM requires a physical address, but it must NOT be a home address —
// set OUTREACH_ADDRESS (a PO Box / virtual business address) in Railway before
// sending. The placeholder below is intentionally not sendable-as-is.
const ADDRESS = process.env.OUTREACH_ADDRESS || "Roaman LLC, [set OUTREACH_ADDRESS to a PO Box before sending]";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function readStdinEnv() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve({});
    let raw = ""; process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
  });
}

const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Styled template (Drew's preference), with the see-and-claim button moved to
// the bottom. Styling isn't what sends it to Promotions — the sender address
// and domain warmup are — so we keep the polished look.
function emailHtml(venue, unsubToken) {
  const page = `${APP}/v/${venue.id}`;
  const unsub = `${API}/api/outreach/unsubscribe?token=${unsubToken}`;
  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;color:#1C1C1C">
    <p style="font-size:15px;line-height:1.6">Hi ${esc(venue.name)} team,</p>
    <p style="font-size:15px;line-height:1.6">I'm Drew — I run <strong>Roaman</strong>, the going-out app for ${esc(venue.city)}. ${esc(venue.name)} is already on our live map, and people are finding you there right now. We built the page; you can claim it and take control, free.</p>
    <p style="font-size:15px;line-height:1.6">Claiming lets you post your specials and events, verify what shows on your page, and get a weekly report on how many people viewed and visited you. It takes about five minutes and is verified by a quick call to your business line. <strong>Founding venues get the full toolkit free for the first year.</strong></p>
    <p style="font-size:15px;line-height:1.6">If you'd rather not be listed, just reply and I'll take the page down.</p>
    <p style="margin:26px 0 8px"><a href="${page}" style="background:#C8A96E;color:#1C1C1C;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold;font-size:15px">See your live page &amp; claim it</a></p>
    <p style="font-size:13px;color:#555;margin:0 0 24px">Thanks — Drew, Roaman</p>
    <hr style="border:none;border-top:1px solid #ddd;margin:24px 0">
    <p style="font-size:11px;color:#999;line-height:1.5">You received this because ${esc(venue.name)} is a public venue listed on Roaman. ${esc(ADDRESS)}. <a href="${unsub}" style="color:#999">Unsubscribe / don't contact this venue</a>.</p>
  </div>`;
}

async function main() {
  const stdinEnv = await readStdinEnv();
  const env = (k) => process.env[k] || stdinEnv[k];
  const supabase = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
  if (!CITY) throw new Error("--city is required");

  const { data: rows, error } = await supabase.from("venue_outreach")
    .select("id, email, unsubscribe_token, status, venues!inner(id, name, city)")
    .eq("status", "harvested").not("email", "is", null).eq("venues.city", CITY);
  if (error) throw new Error(error.message);
  const targets = (rows || []).slice(0, LIMIT);
  console.log(`${CITY}: ${targets.length} venue(s) ready to email (status=harvested).\n`);

  // --test: send a single rendered sample to the given address (e.g. your own
  // inbox) so you can see exactly what venues would receive. No records touched.
  if (TEST_TO) {
    if (!targets.length) { console.log("No harvested venues to render a sample from."); return; }
    if (!env("RESEND_API_KEY")) throw new Error("RESEND_API_KEY not set — cannot send test.");
    const sample = targets[0].venues;
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Roaman <noreply@roaman.app>", to: [TEST_TO], reply_to: "dev@roaman.app",
        subject: `[SAMPLE] ${sample.name} on Roaman`,
        html: emailHtml(sample, targets[0].unsubscribe_token),
      }),
    });
    console.log(resp.ok ? `Sample sent to ${TEST_TO} (rendered for "${sample.name}"). Nothing else touched.` : `Test send failed: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
    return;
  }

  if (PREVIEW && targets.length) {
    const v = targets[0].venues;
    fs.writeFileSync("outreach-preview.html", emailHtml(v, targets[0].unsubscribe_token));
    console.log("Wrote outreach-preview.html (sample for the first venue). Review it before --send.\n");
  }
  targets.slice(0, 15).forEach((t) => console.log(`  → ${t.venues.name}  <${t.email}>`));
  if (targets.length > 15) console.log(`  … and ${targets.length - 15} more`);

  if (!SEND) { console.log("\nDRY RUN — no emails sent. Add --send (only with Drew's approval) to send."); return; }
  if (!env("RESEND_API_KEY")) throw new Error("RESEND_API_KEY not set — cannot send.");

  let sent = 0;
  for (const t of targets) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env("RESEND_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Roaman <noreply@roaman.app>", to: [t.email], reply_to: "dev@roaman.app",
          subject: `${t.venues.name} on Roaman`,
          html: emailHtml(t.venues, t.unsubscribe_token),
        }),
      });
      if (resp.ok) { sent++; await supabase.from("venue_outreach").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", t.id); }
      else console.warn(`  fail ${t.venues.name}: ${resp.status}`);
    } catch (e) { console.warn(`  error ${t.venues.name}: ${e.message}`); }
    await delay(600); // gentle on the sending domain's reputation
  }
  console.log(`\nSent ${sent}/${targets.length}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
