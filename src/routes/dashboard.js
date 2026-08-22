const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const { isPublicHttpUrl, assertPublicUrlAtFetch } = require("../util/safeUrl");

const router = express.Router();

const MARKER_LOGO_MAX_BYTES = 1024 * 1024;

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
    const { data: activeDeals } = await supabase.from("deals").select("*").eq("venue_id", venueId).eq("is_active", true).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: true });
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
  try {
    const { data: venue } = await supabase.from("venues").select("owner_id, plan").eq("id", req.params.venueId).single();
    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Access denied. You don't own this venue." });
    const { enable } = req.body;
    if (enable && venue.plan !== "premium") return res.status(403).json({ error: "Heatmap Boost requires the Premium plan. Upgrade to enable it." });
    const boost_expires_at = enable ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() : null;
    const { error } = await supabase.from("venues").update({ heatmap_boost: !!enable, boost_expires_at }).eq("id", req.params.venueId);
    if (error) throw error;
    res.json({ success: true, heatmap_boost: !!enable });
  } catch (err) {
    console.error("boost update error:", err);
    res.status(500).json({ error: "Failed to update boost." });
  }
});

// PATCH /api/dashboard/:venueId/marker — set or clear the custom map-marker
// logo (paid perk). A new logo always resets marker_approved: it goes through
// manual review before venues.js will serve it on the map.
router.patch("/:venueId/marker", authMiddleware, async (req, res) => {
  try {
    const { data: venue } = await supabase.from("venues").select("owner_id, plan").eq("id", req.params.venueId).single();
    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Access denied. You don't own this venue." });
    const { logo_url } = req.body;
    if (!logo_url) {
      const { error } = await supabase.from("venues").update({ marker_logo_url: null, marker_approved: false }).eq("id", req.params.venueId);
      if (error) throw error;
      return res.json({ success: true, marker_logo_url: null });
    }
    if (venue.plan !== "pro" && venue.plan !== "premium") {
      return res.status(403).json({ error: "Custom map markers require a Pro or Premium plan. Upgrade to enable them." });
    }
    if (!isPublicHttpUrl(logo_url)) return res.status(400).json({ error: "logo_url must be a valid public http(s) URL." });
    let resp;
    try {
      const safeHref = await assertPublicUrlAtFetch(logo_url);
      resp = await fetch(safeHref, { redirect: "error", signal: AbortSignal.timeout(8000) });
    } catch {
      return res.status(400).json({ error: "Couldn't fetch that URL (redirects aren't allowed)." });
    }
    if (!resp.ok) return res.status(400).json({ error: "That URL didn't return an image." });
    const type = (resp.headers.get("content-type") || "").split(";")[0].trim();
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)) {
      return res.status(400).json({ error: "Logo must be a PNG, JPEG, or WebP image." });
    }
    if (Number(resp.headers.get("content-length")) > MARKER_LOGO_MAX_BYTES) {
      return res.status(413).json({ error: "Logo too large (1 MB max)." });
    }
    const body = Buffer.from(await resp.arrayBuffer());
    if (body.length > MARKER_LOGO_MAX_BYTES) return res.status(413).json({ error: "Logo too large (1 MB max)." });
    const { error } = await supabase.from("venues").update({ marker_logo_url: logo_url.trim(), marker_approved: false }).eq("id", req.params.venueId);
    if (error) throw error;
    res.json({ success: true, marker_logo_url: logo_url.trim(), pending_review: true });
  } catch (err) {
    console.error("marker update error:", err);
    res.status(500).json({ error: "Failed to update marker." });
  }
});

router.get("/:venueId/redemptions", authMiddleware, async (req, res) => {
  if (!await requireOwner(req, res, req.params.venueId)) return;
  const { data: deals } = await supabase.from("deals").select("id").eq("venue_id", req.params.venueId);
  const dealIds = (deals || []).map(d => d.id);
  const { data } = await supabase.from("deal_redemptions").select("*, deals(title), users(username)").in("deal_id", dealIds).order("redeemed_at", { ascending: false }).limit(50);
  res.json(data || []);
});

module.exports = router;
