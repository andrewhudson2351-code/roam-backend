const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");

const router = express.Router();

const DEAL_TAGS = [
  "Wings", "Tacos", "Brunch", "Pizza", "Apps/Small Plates",
  "Happy Hour", "Beer", "Cocktails", "Wine", "Shots",
  "Live Music", "Trivia", "Karaoke", "Sports", "Ladies Night",
];

// Recurring deals get a far-future expiry so every existing expires_at filter
// passes; actual visibility is governed by the day/time window check below.
const RECURRING_SENTINEL = "2099-01-01T00:00:00Z";
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function isDealLiveNow(deal, now = new Date()) {
  if (!deal.recur_days) return true;
  const tz = CITY_TIMEZONES[deal.venues?.city] || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(now);
  const day = DAY_NAMES.indexOf(parts.find(p => p.type === "weekday").value);
  const mins = Number(parts.find(p => p.type === "hour").value) * 60 + Number(parts.find(p => p.type === "minute").value);
  const [sh, sm] = deal.recur_start.split(":").map(Number);
  const [eh, em] = deal.recur_end.split(":").map(Number);
  const start = sh * 60 + sm, end = eh * 60 + em;
  if (end > start) return deal.recur_days.includes(day) && mins >= start && mins < end;
  // window wraps past midnight: live if it started today, or is still running from yesterday
  return (deal.recur_days.includes(day) && mins >= start) || (deal.recur_days.includes((day + 6) % 7) && mins < end);
}

router.get("/", async (req, res) => {
  try {
    const { city = "Charlotte", tag, day } = req.query;
    if (tag && !DEAL_TAGS.includes(tag)) return res.status(400).json({ error: "Unknown tag." });
    const now = new Date();
    let query = supabase.from("deals").select(`*, venues(id, name, neighborhood, city, latitude, longitude, category)`).eq("is_active", true).gt("expires_at", now.toISOString()).order("save_count", { ascending: false });
    if (tag) query = query.contains("tags", [tag]);
    const { data, error } = await query;
    if (error) throw error;
    // With ?day=N (0=Sun..6=Sat): every deal that runs that weekday, ignoring
    // time-of-day so users can browse/plan. Without it: only what's live right now.
    let filtered;
    if (day !== undefined && day !== "") {
      const d = Number(day);
      if (!Number.isInteger(d) || d < 0 || d > 6) return res.status(400).json({ error: "day must be an integer 0-6." });
      filtered = data.filter(deal => !deal.recur_days || deal.recur_days.includes(d));
    } else {
      filtered = data.filter(deal => isDealLiveNow(deal, now));
    }
    const deals = city ? filtered.filter(d => d.venues?.city === city) : filtered;
    res.json(deals.map(deal => ({ ...deal, is_live_now: isDealLiveNow(deal, now) })));
  } catch (err) {
    res.status(500).json({ error: "Failed to load deals." });
  }
});

// No 0/O/1/I/L — codes get read aloud to bar staff
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function generateCode() {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return code;
}

function redemptionReceipt(row, deal) {
  return {
    code: row.code,
    redeemed_at: row.redeemed_at,
    deal: { id: deal.id, title: deal.title, description: deal.description },
    venue: { name: deal.venues?.name, city: deal.venues?.city },
  };
}

router.get("/my-redemptions", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase.from("deal_redemptions").select("deal_id, code, redeemed_at").eq("user_id", req.user.id);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: "Failed to load redemptions." });
  }
});

router.post("/:id/redeem", authMiddleware, async (req, res) => {
  try {
    const { data: deal } = await supabase.from("deals").select("*, venues(owner_id, city, name)").eq("id", req.params.id).single();
    if (!deal) return res.status(404).json({ error: "Deal not found." });
    if (deal.source === "scraped") return res.status(403).json({ error: "This deal hasn't been verified by the venue yet, so it can't be redeemed in-app. Mention it at the bar!" });
    if (!deal.is_active || new Date(deal.expires_at) < new Date()) return res.status(400).json({ error: "This deal has expired." });
    if (!isDealLiveNow(deal)) return res.status(400).json({ error: "This deal isn't active right now — check its schedule." });
    if (deal.is_premium_only) {
      const { data: user } = await supabase.from("users").select("is_premium, premium_expires_at").eq("id", req.user.id).single();
      const isPremium = user?.is_premium && new Date(user.premium_expires_at) > new Date();
      if (!isPremium) return res.status(403).json({ error: "This deal is for Premium members only.", upgrade_required: true });
    }
    let row = null;
    for (let attempt = 0; attempt < 3 && !row; attempt++) {
      const { data, error } = await supabase.from("deal_redemptions")
        .insert({ deal_id: req.params.id, user_id: req.user.id, code: generateCode() })
        .select("code, redeemed_at").single();
      if (error) {
        if (error.code === "23505" && (error.message || "").includes("deal_redemptions_code_key")) continue;
        if (error.code === "23505") {
          const { data: existing } = await supabase.from("deal_redemptions").select("code, redeemed_at").eq("deal_id", req.params.id).eq("user_id", req.user.id).single();
          return res.status(409).json({ error: "You have already redeemed this deal.", already_redeemed: true, redemption: existing ? redemptionReceipt(existing, deal) : null });
        }
        throw error;
      }
      row = data;
    }
    if (!row) throw new Error("could not generate a unique redemption code");
    const { error: countError } = await supabase.rpc("increment_deal_redemptions", { p_deal_id: req.params.id });
    if (countError) throw countError;
    res.json({ success: true, redemption: redemptionReceipt(row, deal) });
  } catch (err) {
    console.error("deal redeem error:", err);
    res.status(500).json({ error: "Failed to redeem deal." });
  }
});

router.post("/:id/save", authMiddleware, async (req, res) => {
  try {
    const { data: existing } = await supabase.from("deal_saves").select("*").eq("deal_id", req.params.id).eq("user_id", req.user.id).single();
    if (existing) {
      const { error } = await supabase.from("deal_saves").delete().eq("deal_id", req.params.id).eq("user_id", req.user.id);
      if (error) throw error;
      return res.json({ saved: false });
    }
    const { error } = await supabase.from("deal_saves").insert({ deal_id: req.params.id, user_id: req.user.id });
    if (error) throw error;
    res.json({ saved: true });
  } catch (err) {
    console.error("deal save error:", err);
    res.status(500).json({ error: "Failed to save deal." });
  }
});

// Scraped deals belong to the venue, so once its owner claims the venue they
// can adopt one (it becomes redeemable like an owner deal) or dismiss it.
async function getScrapedDealForOwner(req, res) {
  const { data: deal } = await supabase.from("deals").select("id, source, venues(owner_id)").eq("id", req.params.id).single();
  if (!deal) { res.status(404).json({ error: "Deal not found." }); return null; }
  if (!deal.venues || deal.venues.owner_id !== req.user.id) { res.status(403).json({ error: "You don't own this venue." }); return null; }
  if (deal.source !== "scraped") { res.status(400).json({ error: "Only unverified deals can be adopted or dismissed." }); return null; }
  return deal;
}

router.post("/:id/adopt", authMiddleware, async (req, res) => {
  try {
    if (!await getScrapedDealForOwner(req, res)) return;
    const { data, error } = await supabase.from("deals").update({ source: "owner" }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, deal: data });
  } catch (err) {
    console.error("deal adopt error:", err);
    res.status(500).json({ error: "Failed to verify deal." });
  }
});

router.post("/:id/dismiss", authMiddleware, async (req, res) => {
  try {
    if (!await getScrapedDealForOwner(req, res)) return;
    const { error } = await supabase.from("deals").update({ is_active: false }).eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("deal dismiss error:", err);
    res.status(500).json({ error: "Failed to remove deal." });
  }
});

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id, title, description, detail, is_premium_only, expires_at, tags, recur_days, recur_start, recur_end } = req.body;
    if (!venue_id || !title) return res.status(400).json({ error: "venue_id and title are required." });
    if (!Array.isArray(tags) || tags.length < 1 || tags.length > 3 || tags.some(t => !DEAL_TAGS.includes(t)))
      return res.status(400).json({ error: "Pick 1 to 3 deal tags." });
    const recurring = recur_days != null || recur_start != null || recur_end != null;
    let recurrence = { recur_days: null, recur_start: null, recur_end: null };
    if (recurring) {
      if (!Array.isArray(recur_days) || recur_days.length < 1 || recur_days.length > 7 || recur_days.some(d => !Number.isInteger(d) || d < 0 || d > 6))
        return res.status(400).json({ error: "Pick at least one day of the week." });
      if (!/^\d{2}:\d{2}$/.test(recur_start || "") || !/^\d{2}:\d{2}$/.test(recur_end || "") || recur_start === recur_end)
        return res.status(400).json({ error: "A start and end time are required." });
      recurrence = { recur_days: [...new Set(recur_days)].sort(), recur_start, recur_end };
    } else if (!expires_at) {
      return res.status(400).json({ error: "expires_at is required for one-time deals." });
    }
    const { data: venue } = await supabase.from("venues").select("owner_id").eq("id", venue_id).single();
    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "You don't own this venue." });
    const { data, error } = await supabase.from("deals").insert({ venue_id, title, description, detail, is_premium_only: is_premium_only || false, expires_at: recurring ? RECURRING_SENTINEL : expires_at, tags, ...recurrence }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create deal." });
  }
});

module.exports = router;
module.exports.isDealLiveNow = isDealLiveNow;
module.exports.DEAL_TAGS = DEAL_TAGS;
