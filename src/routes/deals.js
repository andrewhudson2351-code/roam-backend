const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { city = "Charlotte" } = req.query;
    const { data, error } = await supabase.from("deals").select(`*, venues(id, name, neighborhood, city, latitude, longitude, category)`).eq("is_active", true).gt("expires_at", new Date().toISOString()).order("save_count", { ascending: false });
    if (error) throw error;
    const deals = city ? data.filter(d => d.venues?.city === city) : data;
    res.json(deals);
  } catch (err) {
    res.status(500).json({ error: "Failed to load deals." });
  }
});

router.post("/:id/redeem", authMiddleware, async (req, res) => {
  try {
    const { data: deal } = await supabase.from("deals").select("*, venues(owner_id)").eq("id", req.params.id).single();
    if (!deal) return res.status(404).json({ error: "Deal not found." });
    if (!deal.is_active || new Date(deal.expires_at) < new Date()) return res.status(400).json({ error: "This deal has expired." });
    if (deal.is_premium_only) {
      const { data: user } = await supabase.from("users").select("is_premium, premium_expires_at").eq("id", req.user.id).single();
      const isPremium = user?.is_premium && new Date(user.premium_expires_at) > new Date();
      if (!isPremium) return res.status(403).json({ error: "This deal is for Premium members only.", upgrade_required: true });
    }
    const { error } = await supabase.from("deal_redemptions").insert({ deal_id: req.params.id, user_id: req.user.id });
    if (error?.code === "23505") return res.status(409).json({ error: "You have already redeemed this deal." });
    await supabase.from("deals").update({ redemption_count: deal.redemption_count + 1 }).eq("id", req.params.id);
    res.json({ success: true, message: "Deal redeemed! Show this screen at the venue." });
  } catch (err) {
    res.status(500).json({ error: "Failed to redeem deal." });
  }
});

router.post("/:id/save", authMiddleware, async (req, res) => {
  const { data: existing } = await supabase.from("deal_saves").select("*").eq("deal_id", req.params.id).eq("user_id", req.user.id).single();
  if (existing) {
    await supabase.from("deal_saves").delete().eq("deal_id", req.params.id).eq("user_id", req.user.id);
    return res.json({ saved: false });
  }
  await supabase.from("deal_saves").insert({ deal_id: req.params.id, user_id: req.user.id });
  res.json({ saved: true });
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id, title, description, detail, is_premium_only, expires_at } = req.body;
    if (!venue_id || !title || !expires_at) return res.status(400).json({ error: "venue_id, title, and expires_at are required." });
    const { data: venue } = await supabase.from("venues").select("owner_id").eq("id", venue_id).single();
    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "You don't own this venue." });
    const { data, error } = await supabase.from("deals").insert({ venue_id, title, description, detail, is_premium_only: is_premium_only || false, expires_at }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create deal." });
  }
});

module.exports = router;
