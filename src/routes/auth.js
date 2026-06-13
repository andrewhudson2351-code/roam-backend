const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");
const { stripe } = require("../config/stripe");

const router = express.Router();
const signToken = (user) => jwt.sign({ id: user.id, email: user.email, username: user.username }, process.env.JWT_SECRET, { expiresIn: "30d" });

router.post("/register", async (req, res) => {
  try {
    const { email, password, username, display_name, home_city } = req.body;
    if (!email || !password || !username) return res.status(400).json({ error: "Email, password, and username are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const password_hash = await bcrypt.hash(password, 12);
    const { data, error } = await supabase.from("users").insert({ email, password_hash, username, display_name: display_name || username, home_city: home_city || null }).select("id, email, username, display_name, is_premium, home_city").single();
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
  const { data } = await supabase.from("users").select("id, email, username, display_name, is_premium, avatar_url, location_sharing, home_city").eq("id", req.user.id).single();
  res.json(data);
});

router.patch("/me", authMiddleware, async (req, res) => {
  const { display_name, avatar_url, location_sharing, home_city } = req.body;
  const { data } = await supabase.from("users").update({ display_name, avatar_url, location_sharing, home_city }).eq("id", req.user.id).select("id, email, username, display_name, is_premium, avatar_url, location_sharing, home_city").single();
  res.json(data);
});

// DELETE /api/auth/account — Apple 5.1.1 account deletion
router.delete("/account", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Best-effort: cancel any active Stripe subscriptions so billing stops
    const { data: subs } = await supabase
      .from("subscriptions")
      .select("stripe_sub_id, status")
      .eq("owner_id", userId)
      .not("stripe_sub_id", "is", null);
    for (const sub of subs || []) {
      if (["active", "trialing", "past_due"].includes(sub.status)) {
        try {
          await stripe.subscriptions.cancel(sub.stripe_sub_id);
        } catch (err) {
          console.error(`Failed to cancel Stripe sub ${sub.stripe_sub_id}:`, err.message);
        }
      }
    }

    // crowd_reports FK is NO ACTION — would block the user delete
    const { error: crowdError } = await supabase.from("crowd_reports").delete().eq("user_id", userId);
    if (crowdError) throw crowdError;

    // Unclaim venues (FK is NO ACTION; venues are businesses, not user data)
    const { error: venueError } = await supabase
      .from("venues")
      .update({ owner_id: null, is_verified: false, plan: "free" })
      .eq("owner_id", userId);
    if (venueError) throw venueError;

    // subscriptions has no FK to users — rows would be orphaned
    const { error: subError } = await supabase.from("subscriptions").delete().eq("owner_id", userId);
    if (subError) throw subError;

    // users row — CASCADE covers deal_redemptions, deal_saves, friend_locations,
    // friendships, stories, story_likes, venue_claims
    const { error: userError } = await supabase.from("users").delete().eq("id", userId);
    if (userError) throw userError;

    res.json({ success: true });
  } catch (err) {
    console.error("account deletion error:", err);
    res.status(500).json({ error: "Failed to delete account." });
  }
});

module.exports = router;
