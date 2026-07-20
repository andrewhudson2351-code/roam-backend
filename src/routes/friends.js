const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const { notifyUser } = require("../notify");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("friendships").select(`*, requester:users!requester_id(id, username, display_name, avatar_url), addressee:users!addressee_id(id, username, display_name, avatar_url)`).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`).eq("status", "accepted");
    if (error) throw error;
    const friends = (data || []).map(f => ({ friendship_id: f.id, friend: f.requester_id === req.user.id ? f.addressee : f.requester }));
    const friendIds = friends.map(f => f.friend.id);
    const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: locations, error: locError } = await supabase.from("friend_locations").select("*, venues(name, neighborhood)").in("user_id", friendIds).gte("updated_at", staleCutoff);
    if (locError) throw locError;
    const locationMap = Object.fromEntries((locations || []).map(l => [l.user_id, l]));
    res.json(friends.map(f => ({ ...f, location: locationMap[f.friend.id] || null })));
  } catch (err) {
    console.error("friends list error:", err);
    res.status(500).json({ error: "Failed to load friends." });
  }
});

router.get("/requests", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("friendships")
      .select(`id, created_at, requester:users!requester_id(id, username, display_name, avatar_url)`)
      .eq("addressee_id", req.user.id)
      .eq("status", "pending")
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json((data || []).map(f => ({ friendship_id: f.id, requester: f.requester, created_at: f.created_at })));
  } catch (err) {
    console.error("friend requests error:", err);
    res.status(500).json({ error: "Failed to load friend requests." });
  }
});

// GET /api/friends/search?q= — typeahead for the add-friend input
router.get("/search", authMiddleware, async (req, res) => {
  try {
    // strip anything that could break the PostgREST or() filter or act as an ilike wildcard
    const q = (req.query.q || "").trim().replace(/[^a-zA-Z0-9_.\- ]/g, "");
    if (q.length < 2) return res.json([]);
    const { data, error } = await supabase
      .from("users")
      .select("id, username, display_name, avatar_url")
      .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
      .neq("id", req.user.id)
      .order("username")
      .limit(8);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error("friend search error:", err);
    res.status(500).json({ error: "Failed to search users." });
  }
});

router.post("/request", authMiddleware, async (req, res) => {
  try {
    const { username } = req.body;
    if (!username || typeof username !== "string") return res.status(400).json({ error: "Username is required." });
    const { data: target } = await supabase.from("users").select("id").eq("username", username).single();
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.id === req.user.id) return res.status(400).json({ error: "You can't friend yourself." });
    const { error } = await supabase.from("friendships").insert({ requester_id: req.user.id, addressee_id: target.id });
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Friend request already sent." });
      throw error;
    }
    notifyUser(target.id, { title: "New friend request", body: `@${req.user.username} wants to be your friend on Roaman`, data: { type: "friend_request" } });
    res.json({ success: true });
  } catch (err) {
    console.error("friend request error:", err);
    res.status(500).json({ error: "Failed to send friend request." });
  }
});

router.patch("/:id/accept", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("friendships").update({ status: "accepted" }).eq("id", req.params.id).eq("addressee_id", req.user.id).select().single();
    if (error || !data) return res.status(404).json({ error: "Request not found." });
    notifyUser(data.requester_id, { title: "Friend request accepted", body: `@${req.user.username} accepted your friend request`, data: { type: "friend_accept" } });
    res.json({ success: true });
  } catch (err) {
    console.error("friend accept error:", err);
    res.status(500).json({ error: "Failed to accept friend request." });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from("friendships").delete().eq("id", req.params.id).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("friend remove error:", err);
    res.status(500).json({ error: "Failed to remove friend." });
  }
});

router.patch("/location", authMiddleware, async (req, res) => {
  try {
    // venue_id is optional: a live-GPS update (from the map) has no venue,
    // a crowd-report check-in supplies one. Coordinates are always required.
    const { venue_id = null, latitude, longitude, last_seen } = req.body;
    const lat = Number(latitude);
    const lng = Number(longitude);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return res.status(400).json({ error: "latitude and longitude must be valid coordinates." });
    }
    let venue = null;
    if (venue_id) {
      const { data: v } = await supabase.from("venues").select("id, name").eq("id", venue_id).single();
      if (!v) return res.status(400).json({ error: "Venue not found." });
      venue = v;
    }
    const { data: user } = await supabase.from("users").select("location_sharing").eq("id", req.user.id).single();
    if (!user?.location_sharing) return res.status(403).json({ error: "Enable location sharing in your profile settings first." });
    // Detect a NEW check-in (venue changed) before we overwrite the row, so we
    // notify friends once per arrival rather than on every crowd re-report.
    const { data: prev } = await supabase.from("friend_locations").select("venue_id").eq("user_id", req.user.id).maybeSingle();
    const isNewCheckIn = venue && prev?.venue_id !== venue_id;
    const { error } = await supabase.from("friend_locations").upsert({ user_id: req.user.id, venue_id, latitude: lat, longitude: lng, last_seen, updated_at: new Date().toISOString() });
    if (error) throw error;
    res.json({ success: true });
    if (isNewCheckIn) notifyFriendsOfCheckIn(req.user, venue).catch(() => {});
  } catch (err) {
    console.error("friend location error:", err);
    res.status(500).json({ error: "Failed to update location." });
  }
});

// Tell a user's accepted friends (who also share location) that they've arrived.
async function notifyFriendsOfCheckIn(user, venue) {
  const { data: fr } = await supabase.from("friendships")
    .select("requester_id, addressee_id")
    .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`)
    .eq("status", "accepted");
  const friendIds = (fr || []).map(f => f.requester_id === user.id ? f.addressee_id : f.requester_id);
  for (const fid of friendIds) {
    notifyUser(fid, { title: `@${user.username} is out`, body: `Just checked in at ${venue.name}`, data: { type: "checkin", venue_id: venue.id } });
  }
}

module.exports = router;
