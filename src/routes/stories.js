const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id, visibility = "public" } = req.query;
    let query = supabase.from("stories").select(`*, venues(id, name, neighborhood), users(username, display_name, avatar_url)`).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(50);
    if (venue_id) query = query.eq("venue_id", venue_id);
    if (visibility === "public") query = query.eq("visibility", "public");
    const { data, error } = await query;
    if (error) throw error;
    const stories = data.map(s => ({ ...s, users: s.is_anonymous ? null : s.users }));
    res.json(stories);
  } catch (err) {
    res.status(500).json({ error: "Failed to load stories." });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id, caption, media_url, emoji, visibility, is_anonymous } = req.body;
    if (!venue_id) return res.status(400).json({ error: "venue_id is required." });
    const { data, error } = await supabase.from("stories").insert({ user_id: req.user.id, venue_id, caption, media_url, emoji: emoji || "📸", visibility: visibility || "public", is_anonymous: is_anonymous || false }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to post story." });
  }
});

router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const { data: existing } = await supabase.from("story_likes").select("*").eq("user_id", req.user.id).eq("story_id", req.params.id).single();
    if (existing) {
      await supabase.from("story_likes").delete().eq("user_id", req.user.id).eq("story_id", req.params.id);
      return res.json({ liked: false });
    }
    await supabase.from("story_likes").insert({ user_id: req.user.id, story_id: req.params.id });
    res.json({ liked: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to like story." });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  const { data: story } = await supabase.from("stories").select("user_id").eq("id", req.params.id).single();
  if (!story || story.user_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
  await supabase.from("stories").delete().eq("id", req.params.id);
  res.json({ success: true });
});

module.exports = router;
