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

module.exports = router;
