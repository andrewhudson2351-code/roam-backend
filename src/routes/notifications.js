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

// Marketing-push opt-in (Apple 4.5.4). Social pushes are not affected by this.
router.get("/preferences", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("users").select("notify_deals").eq("id", req.user.id).single();
    if (error) throw error;
    res.json({ notify_deals: data.notify_deals });
  } catch (err) {
    res.status(500).json({ error: "Failed to load preferences." });
  }
});

router.patch("/preferences", authMiddleware, async (req, res) => {
  try {
    const { notify_deals } = req.body;
    if (typeof notify_deals !== "boolean") return res.status(400).json({ error: "notify_deals must be true or false." });
    const { error } = await supabase.from("users").update({ notify_deals }).eq("id", req.user.id);
    if (error) throw error;
    res.json({ success: true, notify_deals });
  } catch (err) {
    res.status(500).json({ error: "Failed to update preferences." });
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
