const express = require("express");
const crypto = require("crypto");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// POST /api/stories/upload — base64 image in, public storage URL out.
// Client compresses to ~1280px JPEG before sending; hard cap 5 MB decoded.
router.post("/upload", authMiddleware, async (req, res) => {
  try {
    const { image } = req.body;
    if (typeof image !== "string") return res.status(400).json({ error: "image is required." });
    const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: "image must be a base64 JPEG, PNG, or WebP data URL." });
    const contentType = match[1];
    const buffer = Buffer.from(match[2], "base64");
    if (buffer.length > 5 * 1024 * 1024) return res.status(413).json({ error: "Image too large (5 MB max)." });
    const ext = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1];
    const path = `${req.user.id}/${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from("stories").upload(path, buffer, { contentType });
    if (error) throw error;
    const { data: pub } = supabase.storage.from("stories").getPublicUrl(path);
    res.json({ media_url: pub.publicUrl });
  } catch (err) {
    console.error("story upload error:", err);
    res.status(500).json({ error: "Failed to upload photo." });
  }
});

router.get("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id } = req.query;
    const { data: fr } = await supabase
      .from("friendships")
      .select("requester_id, addressee_id")
      .or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`)
      .eq("status", "accepted");
    const friendIds = (fr || []).map(f => f.requester_id === req.user.id ? f.addressee_id : f.requester_id);
    const allowedAuthors = [req.user.id, ...friendIds].join(",");
    // users must be disambiguated: story_likes adds a second stories<->users relationship (PGRST201)
    let query = supabase.from("stories").select(`*, venues(id, name, neighborhood), users!stories_user_id_fkey(username, display_name, avatar_url)`)
      .gt("expires_at", new Date().toISOString())
      .or(`visibility.eq.public,user_id.in.(${allowedAuthors})`)
      .order("created_at", { ascending: false })
      .limit(50);
    if (venue_id) query = query.eq("venue_id", venue_id);
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
    const today = new Date().toISOString().split("T")[0];
    const { error: aErr } = await supabase.rpc("increment_analytics", { p_venue_id: venue_id, p_date: today, p_field: "story_count" });
    if (aErr) console.error("increment story_count failed:", aErr.message);
  } catch (err) {
    res.status(500).json({ error: "Failed to post story." });
  }
});

router.post("/:id/like", authMiddleware, async (req, res) => {
  try {
    const { data: existing } = await supabase.from("story_likes").select("*").eq("user_id", req.user.id).eq("story_id", req.params.id).single();
    if (existing) {
      const { error } = await supabase.from("story_likes").delete().eq("user_id", req.user.id).eq("story_id", req.params.id);
      if (error) throw error;
      return res.json({ liked: false });
    }
    const { error } = await supabase.from("story_likes").insert({ user_id: req.user.id, story_id: req.params.id });
    if (error) throw error;
    res.json({ liked: true });
  } catch (err) {
    console.error("story like error:", err);
    res.status(500).json({ error: "Failed to like story." });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { data: story } = await supabase.from("stories").select("user_id").eq("id", req.params.id).single();
    if (!story || story.user_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    const { error } = await supabase.from("stories").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("story delete error:", err);
    res.status(500).json({ error: "Failed to delete story." });
  }
});

module.exports = router;
