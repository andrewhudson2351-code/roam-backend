const express = require("express");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

router.get("/", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("friendships").select(`*, requester:users!requester_id(id, username, display_name, avatar_url), addressee:users!addressee_id(id, username, display_name, avatar_url)`).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`).eq("status", "accepted");
  const friends = (data || []).map(f => ({ friendship_id: f.id, friend: f.requester_id === req.user.id ? f.addressee : f.requester }));
  const friendIds = friends.map(f => f.friend.id);
  const { data: locations } = await supabase.from("friend_locations").select("*, venues(name, neighborhood)").in("user_id", friendIds);
  const locationMap = Object.fromEntries((locations || []).map(l => [l.user_id, l]));
  res.json(friends.map(f => ({ ...f, location: locationMap[f.friend.id] || null })));
});

router.post("/request", authMiddleware, async (req, res) => {
  const { username } = req.body;
  const { data: target } = await supabase.from("users").select("id").eq("username", username).single();
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't friend yourself." });
  const { error } = await supabase.from("friendships").insert({ requester_id: req.user.id, addressee_id: target.id });
  if (error?.code === "23505") return res.status(409).json({ error: "Friend request already sent." });
  res.json({ success: true });
});

router.patch("/:id/accept", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("friendships").update({ status: "accepted" }).eq("id", req.params.id).eq("addressee_id", req.user.id).select().single();
  if (!data) return res.status(404).json({ error: "Request not found." });
  res.json({ success: true });
});

router.delete("/:id", authMiddleware, async (req, res) => {
  await supabase.from("friendships").delete().eq("id", req.params.id).or(`requester_id.eq.${req.user.id},addressee_id.eq.${req.user.id}`);
  res.json({ success: true });
});

router.patch("/location", authMiddleware, async (req, res) => {
  const { venue_id, latitude, longitude, last_seen } = req.body;
  const { data: user } = await supabase.from("users").select("location_sharing").eq("id", req.user.id).single();
  if (!user?.location_sharing) return res.status(403).json({ error: "Enable location sharing in your profile settings first." });
  await supabase.from("friend_locations").upsert({ user_id: req.user.id, venue_id, latitude, longitude, last_seen, updated_at: new Date().toISOString() });
  res.json({ success: true });
});

module.exports = router;
