// Shareable link previews. Vercel rewrites app.roaman.app/v/:id and /d/:id
// here; crawlers get OG meta, humans get bounced to the SPA hash route.
// No auth — everything served is already public via the venues/deals API.
const express = require("express");
const { supabase } = require("../config/supabase");

const router = express.Router();
const APP = process.env.APP_BASE_URL || "https://app.roaman.app";

const esc = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function page({ title, description, url }) {
  return `<!doctype html><html><head><meta charset="utf-8">
<title>${esc(title)} · Roaman</title>
<meta property="og:site_name" content="Roaman">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
<meta http-equiv="refresh" content="0;url=${esc(url)}">
</head><body style="font-family:Georgia,serif;background:#1C1C1C;color:#E8D5A3;text-align:center;padding:60px 20px">
<p>${esc(title)}</p><p><a style="color:#C8A96E" href="${esc(url)}">Open in Roaman</a></p>
<script>location.replace(${JSON.stringify(url)});</script>
</body></html>`;
}

router.get("/venue/:id", async (req, res) => {
  try {
    const { data: v } = await supabase.from("venues")
      .select("id, name, city, neighborhood, category, venue_busy_scores(busy_score)")
      .eq("id", req.params.id).single();
    if (!v) return res.status(404).send("Not found");
    const busy = v.venue_busy_scores?.busy_score;
    const description = [`${v.category} in ${v.neighborhood || v.city}`, busy ? `${busy}% busy right now` : null, "Live crowd levels & deals on Roaman"].filter(Boolean).join(" · ");
    res.send(page({ title: v.name, description, url: `${APP}/#/v/${v.id}` }));
  } catch { res.status(500).send("Error"); }
});

router.get("/deal/:id", async (req, res) => {
  try {
    const { data: d } = await supabase.from("deals")
      .select("id, title, is_active, venues(id, name, city)")
      .eq("id", req.params.id).single();
    if (!d) return res.status(404).send("Not found");
    const description = `${d.venues?.name || ""} · ${d.venues?.city || ""} · Deal on Roaman`;
    // Deal links land on the venue sheet with the deal highlighted — the SPA
    // routes #/v/<venue>/d/<deal> hashes (bare #/v/<venue> still works).
    const url = d.venues?.id ? `${APP}/#/v/${d.venues.id}/d/${d.id}` : APP;
    res.send(page({ title: d.title, description, url }));
  } catch { res.status(500).send("Error"); }
});

module.exports = router;
