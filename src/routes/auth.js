const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
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

const RESET_TOKEN_TTL_MS = 15 * 60 * 1000;
const APP_BASE_URL = process.env.APP_BASE_URL || "https://app.roaman.app";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function sendResetEmail(email, resetUrl) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[password-reset] RESEND_API_KEY not set — reset link for ${email}: ${resetUrl}`);
    return;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Roaman <noreply@roaman.app>",
      to: [email],
      subject: "Reset your Roaman password",
      html: `<div style="font-family:Georgia,serif;background:#1C1C1C;color:#FAFAF8;padding:32px;border-radius:12px;max-width:480px;margin:0 auto">
        <h1 style="color:#C8A96E;letter-spacing:3px;font-size:22px;margin:0 0 16px">ROAMAN</h1>
        <p style="font-size:15px;line-height:1.5">Someone requested a password reset for your Roaman account. This link expires in 15 minutes.</p>
        <p style="margin:24px 0"><a href="${resetUrl}" style="background:#C8A96E;color:#1C1C1C;padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold">Reset Password</a></p>
        <p style="font-size:12px;color:#999">If you didn't request this, you can safely ignore this email — your password will not change.</p>
      </div>`,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Resend API ${resp.status}: ${body}`);
  }
}

const forgotPasswordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: "Too many reset requests. Try again later." } });

// POST /api/auth/forgot-password — always responds 200 to prevent account enumeration
router.post("/forgot-password", forgotPasswordLimiter, async (req, res) => {
  const generic = { message: "If that email exists, a reset link has been sent." };
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required." });

    const { data: user } = await supabase.from("users").select("id, email").eq("email", email).single();
    if (!user) return res.json(generic);

    const token = crypto.randomBytes(32).toString("hex");
    await supabase.from("password_reset_tokens").delete().eq("user_id", user.id);
    const { error } = await supabase.from("password_reset_tokens").insert({
      user_id: user.id,
      token_hash: sha256(token),
      expires_at: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    });
    if (error) throw error;

    await sendResetEmail(user.email, `${APP_BASE_URL}/reset-password?token=${token}`);
    res.json(generic);
  } catch (err) {
    console.error("forgot-password error:", err);
    res.json(generic);
  }
});

// POST /api/auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ error: "Token and new password are required." });
    if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });

    const { data: row } = await supabase
      .from("password_reset_tokens")
      .select("id, user_id, expires_at, used_at")
      .eq("token_hash", sha256(token))
      .single();
    if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
      return res.status(400).json({ error: "This reset link is invalid or has expired." });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const { error: updateError } = await supabase.from("users").update({ password_hash }).eq("id", row.user_id);
    if (updateError) throw updateError;
    await supabase.from("password_reset_tokens").update({ used_at: new Date().toISOString() }).eq("id", row.id);

    res.json({ success: true });
  } catch (err) {
    console.error("reset-password error:", err);
    res.status(500).json({ error: "Failed to reset password." });
  }
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
