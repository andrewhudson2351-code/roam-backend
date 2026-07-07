const express = require("express");
const { supabase } = require("../config/supabase");

const router = express.Router();

// GET /api/admin/flagged-claims
// Returns all claim rows where is_flagged=true, with venue name and user info.
// Requires x-admin-secret header (enforced by adminAuth middleware in index.js).
router.get("/flagged-claims", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("venue_claims")
      .select(`
        id,
        venue_id,
        user_id,
        flag_reason,
        submitted_at,
        status,
        venues ( name ),
        users  ( email, username )
      `)
      .eq("is_flagged", true)
      .order("submitted_at", { ascending: false });

    if (error) throw error;

    const claims = data.map((c) => ({
      claim_id:      c.id,
      venue_id:      c.venue_id,
      venue_name:    c.venues?.name    ?? null,
      user_id:       c.user_id,
      user_email:    c.users?.email    ?? null,
      user_username: c.users?.username ?? null,
      flag_reason:   c.flag_reason,
      submitted_at:  c.submitted_at,
      status:        c.status,
    }));

    res.json(claims);
  } catch (err) {
    console.error("admin/flagged-claims error:", err);
    res.status(500).json({ error: "Failed to load flagged claims." });
  }
});

module.exports = router;
