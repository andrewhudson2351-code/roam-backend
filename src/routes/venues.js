const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const { city, neighborhood, category } = req.query;

    let query = supabase
      .from("venues")
      .select(`*, venue_busy_scores(busy_score, report_count, last_updated)`);

    if (city && city !== "all") query = query.eq("city", city);
    if (neighborhood) query = query.eq("neighborhood", neighborhood);
    if (category) query = query.eq("category", category);

    query = query.limit(500);

    const { data, error } = await query;
    if (error) throw error;

    const venues = data.map(v => ({
      ...v,
      busy_score: v.venue_busy_scores?.busy_score ?? 0,
      report_count: v.venue_busy_scores?.report_count ?? 0,
      venue_busy_scores: undefined,
    }));

    res.json(venues);
  } catch (err) {
    res.status(500).json({ error: "Failed to load venues." });
  }
});

router.get("/:id", async (req, res) => {
  try {
    const { data: venue, error } = await supabase.from("venues").select(`*, venue_busy_scores(busy_score, report_count)`).eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Venue not found." });
    const { data: deals } = await supabase.from("deals").select("*").eq("venue_id", req.params.id).eq("is_active", true).gt("expires_at", new Date().toISOString());
    const { data: stories } = await supabase.from("stories").select("id, caption, emoji, visibility, is_anonymous, like_count, created_at, users(username, display_name, avatar_url)").eq("venue_id", req.params.id).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(10);
    res.json({ ...venue, busy_score: venue.venue_busy_scores?.busy_score ?? 0, deals: deals || [], stories: stories || [] });
  } catch (err) {
    res.status(500).json({ error: "Failed to load venue." });
  }
});

router.post("/:id/crowd", authMiddleware, async (req, res) => {
  try {
    const { busy_level } = req.body;
    if (typeof busy_level !== "number" || busy_level < 0 || busy_level > 100) return res.status(400).json({ error: "busy_level must be a number between 0-100." });
    await supabase.from("crowd_reports").insert({ venue_id: req.params.id, user_id: req.user.id, busy_level });
    const { data: scores } = await supabase.from("crowd_reports").select("busy_level").eq("venue_id", req.params.id).gt("reported_at", new Date(Date.now() - 90 * 60 * 1000).toISOString());
    const avg = scores.reduce((sum, r) => sum + r.busy_level, 0) / scores.length;
    await supabase.from("venue_busy_scores").upsert({ venue_id: req.params.id, busy_score: Math.round(avg), report_count: scores.length, last_updated: new Date().toISOString() });
    res.json({ success: true, new_score: Math.round(avg) });
  } catch (err) {
    res.status(500).json({ error: "Failed to submit crowd report." });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram } = req.body;
    if (!name || !address || !neighborhood || !latitude || !longitude) return res.status(400).json({ error: "name, address, neighborhood, latitude, longitude are required." });
    const { data, error } = await supabase.from("venues").insert({ name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram, owner_id: req.user.id }).select().single();
    if (error) throw error;
    res.status(201).json(data);
module.exports = router;
