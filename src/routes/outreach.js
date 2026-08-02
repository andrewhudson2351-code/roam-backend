// Unsubscribe endpoint for the venue-claim outreach campaign (CAN-SPAM
// requires a working opt-out). No auth — the opaque token is the authorization.
const express = require("express");
const { supabase } = require("../config/supabase");

const router = express.Router();

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:Georgia,serif;background:#1C1C1C;color:#E8D5A3;text-align:center;padding:60px 24px">
<h1 style="color:#C8A96E;letter-spacing:3px;font-size:22px">ROAMAN</h1><p style="font-size:15px;max-width:420px;margin:16px auto;line-height:1.6">${body}</p></body></html>`;

router.get("/unsubscribe", async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== "string") return res.status(400).send(page("Unsubscribe", "Invalid unsubscribe link."));
  try {
    const { data, error } = await supabase.from("venue_outreach")
      .update({ status: "unsubscribed" }).eq("unsubscribe_token", token).neq("status", "claimed").select("id");
    if (error) throw error;
    if (!data || !data.length) return res.send(page("Unsubscribe", "You're already unsubscribed, or this link has expired. We won't contact this venue again."));
    res.send(page("Unsubscribed", "Done — we won't email this venue again. If you change your mind, your venue's page is always at app.roaman.app."));
  } catch (err) {
    console.error("outreach unsubscribe error:", err.message);
    res.status(500).send(page("Unsubscribe", "Something went wrong. Email dev@roaman.app and we'll remove you."));
  }
});

module.exports = router;
