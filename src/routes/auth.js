const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();
const signToken = (user) => jwt.sign({ id: user.id, email: user.email, username: user.username }, process.env.JWT_SECRET, { expiresIn: "30d" });

router.post("/register", async (req, res) => {
  try {
    const { email, password, username, display_name } = req.body;
    if (!email || !password || !username) return res.status(400).json({ error: "Email, password, and username are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from("users").insert({ email, password_hash, username, display_name: display_name || username }).select("id, email, username, display_name, is_premium").single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "Email or username already taken." });
      throw error;
    }
    res.status(201).json({ user: data, token: signToken(data) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed." });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email and password required." });

    const { data: user, error } = await supabase.from("users").select("*").eq("email", email).single();
    if (error || !user) return res.status(401).json({ error: "Invalid email or password." });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, token: signToken(user) });
  } catch (err) {
    res.status(500).json({ error: "Login failed." });
  }
});

router.get("/me", authMiddleware, async (req, res) => {
  const { data } = await supabase.from("users").select("id, email, username, display_name, is_premium, avatar_url, location_sharing").eq("id", req.user.id).single();
  res.json(data);
});

router.patch("/me", authMiddleware, async (req, res) => {
  const { display_name, avatar_url, location_sharing } = req.body;
  const { data } = await supabase.from("users").update({ display_name, avatar_url, location_sharing }).eq("id", req.user.id).select("id, email, username, display_name, is_premium, avatar_url, location_sharing").single();
  res.json(data);
});

// ── DELETE /api/auth/me ────────────────────────────────
// Add this to src/routes/auth.js
// Cascades through all user data then deletes the user row

router.delete("/me", authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    // Delete in dependency order
    await supabase.from("friend_locations").delete().eq("user_id", userId);
    await supabase.from("friendships").delete().or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
    await supabase.from("story_likes").delete().eq("user_id", userId);
    await supabase.from("deal_redemptions").delete().eq("user_id", userId);
    await supabase.from("deal_saves").delete().eq("user_id", userId);
    await supabase.from("crowd_reports").delete().eq("user_id", userId);
    await supabase.from("stories").delete().eq("user_id", userId);
    await supabase.from("venue_claims").delete().eq("user_id", userId);
    // Unclaim any venues this user owned
    await supabase.from("venues").update({ owner_id: null, is_verified: false }).eq("owner_id", userId);
    // Delete the user row
    const { error } = await supabase.from("users").delete().eq("id", userId);
    if (error) throw error;
    res.json({ success: true, message: "Account deleted." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete account. Please try again." });
  }
});

module.exports = router;
