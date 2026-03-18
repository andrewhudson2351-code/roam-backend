const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

async function requireOwner(req, res, venueId) {
  const { data } = await supabase.from("venues").select("owner_id").eq("id", venueId).single();
  if (!data || data.owner_id !== req.user.id) {
    res.status(403).json({ error: "Access denied. You don't own this venue." });
    return false;
  }
  return true;
}

router.get("/:venueId", authMiddleware, async (req, res) => {
  try {
    if (!await requireOwner(req, res, req.params.venueId)) return;
    const venueId = req.params.venueId;
    const today = new Date().toISOString().split("T")[0];
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const { data: venue } = await supabase.from("venues").select("*").eq("id", venueId).single();
    const { data: todayStats } = await supabase.from("venue_analytics").select("*").eq("venue_id", venueId).eq("date", today).single();
    const { data: weeklyStats } = await supabase.from("venue_analytics").select("*").eq("venue_id", venueId).gte("date", sevenDaysAgo).order("date", { ascending: true });
    const { data: activeDeals } = await supabase.from("deals").select("*").eq("venue_id", venueId).eq("is_active", true).gt("expires_at", new Date().toISOString());
    const { data: expiredDeals } = await supabase.from("deals").select("*").eq("venue_id", venueId).lt("expires_at", new Date().toISOString()).order("expires_at", { ascending: false }).limit(5);
    const { data: crowdScore } = await supabase.from("venue_busy_scores").select("*").eq("venue_id", venueId).single();
    res.json({
      venue,
      today: todayStats || { visitor_count: 0, deal_redemptions: 0, story_count: 0, profile_views: 0 },
      weekly: weeklyStats || [],
      active_deals: activeDeals || [],
      expired_deals: expiredDeals || [],
      crowd: crowdScore || { busy_score: 0, report_count: 0 },
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to load dashboard." });
  }
});

router.patch("/:venueId/boost", authMiddleware, async (req, res) => {
  if (!await requireOwner(req, res, req.params.venueId)) return;
  const { enable } = req.body;
  const boost_expires_at = enable ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
  await supabase.from("venues").update({ heatmap_boost: enable, boost_expires_at }).eq("id", req.params.venueId);
  res.json({ success: true, heatmap_boost: enable });
});

router.get("/:venueId/redemptions", authMiddleware, async (req, res) => {
  if (!await requireOwner(req, res, req.params.venueId)) return;
  const { data: deals } = await supabase.from("deals").select("id").eq("venue_id", req.params.venueId);
  const dealIds = (deals || []).map(d => d.id);
  const { data } = await supabase.from("deal_redemptions").select("*, deals(title), users(username)").in("deal_id", dealIds).order("redeemed_at", { ascending: false }).limit(50);
  res.json(data || []);
});

module.exports = router;
