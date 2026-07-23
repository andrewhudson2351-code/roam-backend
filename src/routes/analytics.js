const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const { computeVenueAnalytics, renderDigestHtml } = require("../analytics/compute");

const router = express.Router();

const EVENT_TYPES = ["venue_view", "deal_click"];

// POST /api/analytics/event — fire-and-forget tracking ping from the app.
router.post("/event", authMiddleware, async (req, res) => {
  try {
    const { type, venue_id, deal_id = null } = req.body;
    if (!EVENT_TYPES.includes(type)) return res.status(400).json({ error: "Invalid event type." });
    if (!venue_id) return res.status(400).json({ error: "venue_id is required." });
    if (type === "deal_click" && !deal_id) return res.status(400).json({ error: "deal_id is required for deal_click." });
    const { error } = await supabase.from("analytics_events").insert({
      venue_id, deal_id, user_id: req.user.id, event_type: type,
    });
    if (error) throw error;
    res.status(204).end();
    if (type === "venue_view") {
      const today = new Date().toISOString().split("T")[0];
      const { error: aErr } = await supabase.rpc("increment_analytics", { p_venue_id: venue_id, p_date: today, p_field: "profile_views" });
      if (aErr) console.error("increment profile_views failed:", aErr.message);
    }
  } catch (err) {
    console.error("analytics event error:", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Failed to record event." });
  }
});

async function requireOwner(req, res, venueId) {
  const { data } = await supabase.from("venues").select("owner_id").eq("id", venueId).single();
  if (!data || data.owner_id !== req.user.id) {
    res.status(403).json({ error: "Access denied. You don't own this venue." });
    return false;
  }
  return true;
}

// GET /api/analytics/venue/:venueId — full breakout for the Analytics screen.
router.get("/venue/:venueId", authMiddleware, async (req, res) => {
  try {
    if (!await requireOwner(req, res, req.params.venueId)) return;
    res.json(await computeVenueAnalytics(req.params.venueId));
  } catch (err) {
    console.error("venue analytics error:", err);
    res.status(500).json({ error: "Failed to load analytics." });
  }
});

// GET /api/analytics/venue/:venueId/digest — HTML preview of the weekly email.
router.get("/venue/:venueId/digest", authMiddleware, async (req, res) => {
  try {
    if (!await requireOwner(req, res, req.params.venueId)) return;
    const data = await computeVenueAnalytics(req.params.venueId);
    res.type("html").send(renderDigestHtml(data));
  } catch (err) {
    console.error("digest preview error:", err);
    res.status(500).json({ error: "Failed to render digest." });
  }
});

module.exports = router;
