const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

// The app registers its APNs device token here after the user grants push.
router.post("/register", authMiddleware, async (req, res) => {
  try {
    const { token, platform } = req.body;
    if (!token || typeof token !== "string") return res.status(400).json({ error: "token is required." });
    const { error } = await supabase.from("device_tokens").upsert(
      { token, user_id: req.user.id, platform: platform || "ios", updated_at: new Date().toISOString() },
      { onConflict: "token" }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("register device token error:", err);
    res.status(500).json({ error: "Failed to register device." });
  }
});

// Called on logout so a shared device stops getting the previous user's pushes.
router.post("/unregister", authMiddleware, async (req, res) => {
  try {
    const { token } = req.body;
    if (token) await supabase.from("device_tokens").delete().eq("token", token).eq("user_id", req.user.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to unregister device." });
  }
});

module.exports = router;
