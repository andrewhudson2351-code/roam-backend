const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// GET /api/venues/search?q=name
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: "Search query must be at least 2 characters." });
    const { data, error } = await supabase
      .from("venues")
      .select("id, name, address, neighborhood, city, category, owner_id, latitude, longitude")
      .ilike("name", `%${q.trim()}%`)
      .limit(20);
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Search failed." });
  }
});

// GET /api/venues/mine
router.get("/mine", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("venues")
      .select(`*, venue_busy_scores(busy_score, report_count)`)
      .eq("owner_id", req.user.id);
    if (error) throw error;
    const venues = data.map(v => ({
      ...v,
      busy_score: v.venue_busy_scores?.busy_score ?? 0,
      venue_busy_scores: undefined,
    }));
    res.json(venues);
  } catch (err) {
    res.status(500).json({ error: "Failed to load your venues." });
  }
});

// POST /api/venues/:id/claim
router.post("/:id/claim", authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const userId = req.user.id;
    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, name, owner_id")
      .eq("id", venueId)
      .single();
    if (venueError || !venue) return res.status(404).json({ error: "Venue not found." });
    if (venue.owner_id && venue.owner_id !== userId) return res.status(409).json({ error: "This venue has already been claimed." });
    if (venue.owner_id === userId) return res.status(409).json({ error: "You have already claimed this venue." });
    const { error: claimError } = await supabase
      .from("venue_claims")
      .upsert({ venue_id: venueId, user_id: userId, status: "approved", approved_at: new Date().toISOString() });
    if (claimError) throw claimError;
    const { data: updated, error: updateError } = await supabase
      .from("venues")
      .update({ owner_id: userId, is_verified: true })
      .eq("id", venueId)
      .select("id, name, address, neighborhood, city, category")
      .single();
    if (updateError) throw updateError;
    res.json({ success: true, venue: updated, message: `You are now the verified owner of ${updated.name}.` });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Claim failed. Please try again." });
  }
});

// GET /api/venues
// ── GET /api/venues/baseline?city=Charlotte ───────────
// Add this route to venues.js BEFORE the router.get("/") route
// Returns baseline busy scores from BestTime data for current day/hour

router.get("/baseline", async (req, res) => {
  try {
    const { city } = req.query;
    if (!city) return res.status(400).json({ error: "city is required" });

    // Current day and hour (0=Monday...6=Sunday, 0-23 hour)
    const now = new Date();
    const dayInt = (now.getDay() + 6) % 7; // JS Sunday=0, BestTime Monday=0
    const hour = now.getHours();

    // Get all venues in city with their typical hours for today
    const { data, error } = await supabase
      .from("venue_typical_hours")
      .select(`
        venue_id,
        hour_data,
        venues!inner(id, city, latitude, longitude)
      `)
      .eq("day_int", dayInt)
      .eq("venues.city", city);

    if (error) throw error;

    const baselines = data
      .filter(row => Array.isArray(row.hour_data) && row.hour_data.length === 24)
      .map(row => ({
        venue_id: row.venue_id,
        baseline_score: Math.round(row.hour_data[hour] || 0),
      }));

    res.json({ day_int: dayInt, hour, baselines });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load baseline scores." });
  }
});
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

// GET /api/venues/:id
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

// POST /api/venues/:id/crowd
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

// POST /api/venues
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram } = req.body;
    if (!name || !address || !neighborhood || !latitude || !longitude) return res.status(400).json({ error: "name, address, neighborhood, latitude, longitude are required." });
    const { data, error } = await supabase.from("venues").insert({ name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram, owner_id: req.user.id }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create venue." });
  }
});

// PATCH /api/venues/:id
router.patch("/:id", authMiddleware, async (req, res) => {
  const { data: venue } = await supabase.from("venues").select("owner_id").eq("id", req.params.id).single();
  if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
  const allowed = ["name", "description", "address", "phone", "website", "instagram", "cover_image_url", "heatmap_boost"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  const { data } = await supabase.from("venues").update(updates).eq("id", req.params.id).select().single();
  res.json(data);
});

module.exports = router;
