const express = require("express");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");
const { DEAL_TAGS } = require("./deals");

const router = express.Router();

const EVENT_TAGS = [...DEAL_TAGS, "Tasting", "Comedy", "DJ Set", "Theme Night"];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const MAX_RANGE_DAYS = 60;

// ---- date helpers (all calendar dates are YYYY-MM-DD strings; they compare lexicographically)

function cityNow(city, now = new Date()) {
  const tz = CITY_TIMEZONES[city] || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = t => parts.find(p => p.type === t).value;
  return {
    dateStr: `${get("year")}-${get("month")}-${get("day")}`,
    mins: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function weekdayOf(dateStr) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat, same as deals
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toMins(t) {
  const [h, m] = String(t).split(":").map(Number);
  return h * 60 + m;
}

function occursOnDate(event, dateStr) {
  if (event.event_date) return event.event_date === dateStr;
  if (!event.recur_days) return false;
  if (event.recur_until && dateStr > event.recur_until) return false;
  return event.recur_days.includes(weekdayOf(dateStr));
}

function isEventNow(event, now = new Date()) {
  const { dateStr, mins } = cityNow(event.venues?.city, now);
  const startT = event.event_date ? event.start_time : event.recur_start;
  const endT = event.event_date ? event.end_time : event.recur_end;
  if (!startT || !endT) return false;
  const start = toMins(startT), end = toMins(endT);
  const yesterday = addDays(dateStr, -1);
  if (end > start) return occursOnDate(event, dateStr) && mins >= start && mins < end;
  // window wraps past midnight
  return (occursOnDate(event, dateStr) && mins >= start) || (occursOnDate(event, yesterday) && mins < end);
}

// Occurrences within [fromStr, toStr]. If fromStr is the venue's "today", today only
// counts when the event hasn't already ended (wrapping windows never count as ended).
function occurrencesInRange(event, fromStr, toStr, now = new Date()) {
  const { dateStr: todayStr, mins } = cityNow(event.venues?.city, now);
  const out = [];
  for (let d = fromStr; d <= toStr; d = addDays(d, 1)) {
    if (!occursOnDate(event, d)) continue;
    if (d === todayStr) {
      const endT = event.event_date ? event.end_time : event.recur_end;
      const startT = event.event_date ? event.start_time : event.recur_start;
      if (endT && startT && toMins(endT) > toMins(startT) && mins >= toMins(endT)) continue; // already over today
    }
    out.push(d);
    if (out.length >= MAX_RANGE_DAYS) break;
  }
  return out;
}

function shapeEvent(e, fromStr, toStr, now = new Date()) {
  const deals = (e.event_deals || [])
    .map(ed => ed.deals)
    .filter(d => d && d.is_active && new Date(d.expires_at) > now);
  const occurrences = occurrencesInRange(e, fromStr, toStr, now);
  return {
    ...e,
    event_deals: undefined,
    deals,
    occurrences,
    next_occurrence: occurrences[0] || null,
    is_now: isEventNow(e, now),
  };
}

const EVENT_SELECT = `*, venues(id, name, neighborhood, city, latitude, longitude, category),
  event_deals(deals(id, title, detail, description, tags, is_premium_only, is_active, expires_at, recur_days, recur_start, recur_end))`;

router.get("/", async (req, res) => {
  try {
    const { city = "Charlotte", from, to } = req.query;
    if ((from && !DATE_RE.test(from)) || (to && !DATE_RE.test(to)))
      return res.status(400).json({ error: "Dates must be YYYY-MM-DD." });
    const now = new Date();
    const { data, error } = await supabase.from("events").select(EVENT_SELECT).eq("is_active", true);
    if (error) throw error;
    const inCity = city ? data.filter(e => e.venues?.city === city) : data;
    const shaped = inCity
      .map(e => {
        const fromStr = from || cityNow(e.venues?.city, now).dateStr;
        let toStr = to || addDays(fromStr, 30);
        if (toStr > addDays(fromStr, MAX_RANGE_DAYS)) toStr = addDays(fromStr, MAX_RANGE_DAYS);
        return shapeEvent(e, fromStr, toStr, now);
      })
      .filter(e => e.occurrences.length > 0)
      .sort((a, b) => (b.is_now - a.is_now) || a.next_occurrence.localeCompare(b.next_occurrence));
    res.json(shaped);
  } catch (err) {
    console.error("events list error:", err);
    res.status(500).json({ error: "Failed to load events." });
  }
});

function validateSchedule(body) {
  const oneTime = body.event_date != null;
  const recurring = body.recur_days != null;
  if (oneTime === recurring) return { error: "Provide either an event date or recurring days, not both." };
  if (oneTime) {
    if (!DATE_RE.test(body.event_date)) return { error: "event_date must be YYYY-MM-DD." };
    if (!TIME_RE.test(body.start_time || "") || !TIME_RE.test(body.end_time || "") || body.start_time === body.end_time)
      return { error: "A start and end time are required." };
    return { schedule: { event_date: body.event_date, start_time: body.start_time, end_time: body.end_time, recur_days: null, recur_start: null, recur_end: null, recur_until: null } };
  }
  const days = body.recur_days;
  if (!Array.isArray(days) || days.length < 1 || days.length > 7 || days.some(d => !Number.isInteger(d) || d < 0 || d > 6))
    return { error: "Pick at least one day of the week." };
  if (!TIME_RE.test(body.recur_start || "") || !TIME_RE.test(body.recur_end || "") || body.recur_start === body.recur_end)
    return { error: "A start and end time are required." };
  if (body.recur_until != null && !DATE_RE.test(body.recur_until))
    return { error: "recur_until must be YYYY-MM-DD." };
  return { schedule: { event_date: null, start_time: null, end_time: null, recur_days: [...new Set(days)].sort(), recur_start: body.recur_start, recur_end: body.recur_end, recur_until: body.recur_until || null } };
}

async function verifyLinkedDeals(venue_id, ids) {
  if (ids == null) return { deal_ids: null };
  if (!Array.isArray(ids) || ids.length > 10) return { error: "linked_deal_ids must be a list of up to 10 deals." };
  if (ids.length === 0) return { deal_ids: [] };
  const unique = [...new Set(ids)];
  const { data, error } = await supabase.from("deals").select("id").eq("venue_id", venue_id).in("id", unique);
  if (error) throw error;
  if ((data || []).length !== unique.length) return { error: "All linked deals must belong to this venue." };
  return { deal_ids: unique };
}

async function requireOwnedVenue(venue_id, userId) {
  const { data: venue } = await supabase.from("venues").select("owner_id").eq("id", venue_id).single();
  return venue && venue.owner_id === userId;
}

router.post("/", authMiddleware, async (req, res) => {
  try {
    const { venue_id, title, description, cover_image_url, tags, linked_deal_ids } = req.body;
    if (!venue_id || !title) return res.status(400).json({ error: "venue_id and title are required." });
    if (!Array.isArray(tags) || tags.length < 1 || tags.length > 3 || tags.some(t => !EVENT_TAGS.includes(t)))
      return res.status(400).json({ error: "Pick 1 to 3 event tags." });
    const sched = validateSchedule(req.body);
    if (sched.error) return res.status(400).json({ error: sched.error });
    if (!(await requireOwnedVenue(venue_id, req.user.id))) return res.status(403).json({ error: "You don't own this venue." });
    const linked = await verifyLinkedDeals(venue_id, linked_deal_ids);
    if (linked.error) return res.status(400).json({ error: linked.error });

    const { data: event, error } = await supabase.from("events")
      .insert({ venue_id, title, description, cover_image_url, tags, ...sched.schedule })
      .select().single();
    if (error) throw error;
    if (linked.deal_ids?.length) {
      const { error: linkErr } = await supabase.from("event_deals").insert(linked.deal_ids.map(deal_id => ({ event_id: event.id, deal_id })));
      if (linkErr) throw linkErr;
    }
    res.status(201).json({ ...event, linked_deal_ids: linked.deal_ids || [] });
  } catch (err) {
    console.error("event create error:", err);
    res.status(500).json({ error: "Failed to create event." });
  }
});

async function loadOwnedEvent(eventId, userId) {
  const { data: event } = await supabase.from("events").select("*, venues(owner_id)").eq("id", eventId).single();
  if (!event) return { status: 404, error: "Event not found." };
  if (event.venues?.owner_id !== userId) return { status: 403, error: "You don't own this venue." };
  return { event };
}

router.patch("/:id", authMiddleware, async (req, res) => {
  try {
    const owned = await loadOwnedEvent(req.params.id, req.user.id);
    if (owned.error) return res.status(owned.status).json({ error: owned.error });
    const patch = {};
    for (const f of ["title", "description", "cover_image_url", "is_active"]) {
      if (req.body[f] !== undefined) patch[f] = req.body[f];
    }
    if (req.body.tags !== undefined) {
      if (!Array.isArray(req.body.tags) || req.body.tags.length < 1 || req.body.tags.length > 3 || req.body.tags.some(t => !EVENT_TAGS.includes(t)))
        return res.status(400).json({ error: "Pick 1 to 3 event tags." });
      patch.tags = req.body.tags;
    }
    const scheduleTouched = ["event_date", "start_time", "end_time", "recur_days", "recur_start", "recur_end", "recur_until"].some(f => req.body[f] !== undefined);
    if (scheduleTouched) {
      const sched = validateSchedule(req.body);
      if (sched.error) return res.status(400).json({ error: sched.error });
      Object.assign(patch, sched.schedule);
    }
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabase.from("events").update(patch).eq("id", req.params.id).select().single();
    if (error) throw error;
    if (req.body.linked_deal_ids !== undefined) {
      const linked = await verifyLinkedDeals(owned.event.venue_id, req.body.linked_deal_ids);
      if (linked.error) return res.status(400).json({ error: linked.error });
      const { error: delErr } = await supabase.from("event_deals").delete().eq("event_id", req.params.id);
      if (delErr) throw delErr;
      if (linked.deal_ids?.length) {
        const { error: linkErr } = await supabase.from("event_deals").insert(linked.deal_ids.map(deal_id => ({ event_id: req.params.id, deal_id })));
        if (linkErr) throw linkErr;
      }
    }
    res.json(data);
  } catch (err) {
    console.error("event update error:", err);
    res.status(500).json({ error: "Failed to update event." });
  }
});

router.delete("/:id", authMiddleware, async (req, res) => {
  try {
    const owned = await loadOwnedEvent(req.params.id, req.user.id);
    if (owned.error) return res.status(owned.status).json({ error: owned.error });
    const { error } = await supabase.from("events").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error("event delete error:", err);
    res.status(500).json({ error: "Failed to delete event." });
  }
});

module.exports = router;
module.exports.EVENT_TAGS = EVENT_TAGS;
module.exports.shapeEvent = shapeEvent;
module.exports.cityNow = cityNow;
module.exports.addDays = addDays;
