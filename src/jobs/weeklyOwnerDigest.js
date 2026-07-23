// Monday-morning analytics digest emailed to every claimed venue's owner.
// Free for all claimed venues (year-one policy); plan gating can slot in here
// later. No-ops (with a log) when RESEND_API_KEY is unset.

const { supabase } = require("../config/supabase");
const { computeVenueAnalytics, renderDigestHtml } = require("../analytics/compute");

async function sendDigestEmail(email, venueName, html) {
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Roaman <noreply@roaman.app>",
      to: [email],
      subject: `Your weekly Roaman report — ${venueName}`,
      html,
    }),
  });
  if (!resp.ok) throw new Error(`Resend API ${resp.status}: ${await resp.text()}`);
}

async function weeklyOwnerDigest() {
  if (!process.env.RESEND_API_KEY) {
    console.log("[weekly-digest] RESEND_API_KEY not set — skipping send.");
    return 0;
  }
  const { data: venues, error } = await supabase
    .from("venues")
    .select("id, name, owner_id, users:owner_id (email)")
    .not("owner_id", "is", null);
  if (error) throw error;
  let sent = 0;
  for (const v of venues || []) {
    const email = v.users?.email;
    if (!email) continue;
    try {
      const data = await computeVenueAnalytics(v.id);
      await sendDigestEmail(email, v.name, renderDigestHtml(data));
      sent++;
    } catch (err) {
      console.error(`[weekly-digest] ${v.name}: ${err.message}`);
    }
  }
  return sent;
}

module.exports = weeklyOwnerDigest;
