const express = require("express");
const jwt = require("jsonwebtoken");
const { supabase } = require("../config/supabase");
const authMiddleware = require("../middleware/auth");
const rateLimit = require("express-rate-limit");
const { client: twilioClient, verifyService } = require("../config/twilio");
const { PLACES_KEY, fetchPlaceDetails, resolvePhotoUri } = require("../config/places");
const { isDealLiveNow } = require("./deals");
const { shapeEvent, cityNow, addDays } = require("./events");

const router = express.Router();

// Normalise an arbitrary phone string to E.164.  Returns null if unable.
function toE164(phone) {
  if (!phone) return null;
  const stripped = phone.trim();
  if (/^\+\d{10,15}$/.test(stripped)) return stripped;
  const digits = stripped.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return null;
}

const crowdReportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => req.user.id,
  message: { error: "You're reporting too often. Try again in a few minutes." },
});

// GET /api/venues/search?q=name
router.get("/search", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: "Search query must be at least 2 characters." });
    const { data, error } = await supabase
      .from("venues")
      .select("id, name, address, neighborhood, city, category, owner_id, latitude, longitude")
      .ilike("name", `%${q.trim()}%`)
      .limit(20);
    if (error) throw error;
    res.json(data.map(({ owner_id, ...v }) => ({ ...v, is_claimed: !!owner_id })));
  } catch (err) {
    res.status(500).json({ error: "Search failed." });
  }
});

// GET /api/venues/mine
router.get("/mine", authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("venues")
      .select("*, venue_busy_scores(busy_score, report_count)")
      .eq("owner_id", req.user.id);
    if (error) throw error;
    const venues = data.map(v => ({
      ...v,
      busy_score: v.venue_busy_scores?.busy_score ?? 0,
      venue_busy_scores: undefined,
    }));
    res.json(venues);
  } catch (err) {
    res.status(500).json({ error: "Failed to load your venues." });
  }
});

// POST /api/venues/:id/claim/start  -- initiate phone-verified claim
router.post("/:id/claim/start", authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const userId  = req.user.id;

    // 1. Fetch venue
    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, name, owner_id, phone")
      .eq("id", venueId)
      .single();
    if (venueError || !venue) return res.status(404).json({ error: "Venue not found." });

    // 2. Already claimed?
    if (venue.owner_id) {
      const msg = venue.owner_id === userId
        ? "You are already the verified owner of this venue."
        : "This venue has already been claimed by another user.";
      return res.status(409).json({ error: msg });
    }

    // 3. Re-claim check -- previous approved claim exists even though owner_id is null
    const { data: prevClaim } = await supabase
      .from("venue_claims")
      .select("id")
      .eq("venue_id", venueId)
      .eq("status", "approved")
      .maybeSingle();

    if (prevClaim) {
      await supabase
        .from("venue_claims")
        .upsert({
          venue_id:     venueId,
          user_id:      userId,
          status:       "blocked",
          is_flagged:   true,
          flag_reason:  "re-claim: venue had previous owner",
          submitted_at: new Date().toISOString(),
        }, { onConflict: 'venue_id, user_id' });
      return res.status(403).json({
        error: "This venue was previously claimed. Your request has been submitted for manual review.",
      });
    }

    // 4. Resolve phone number
    const rawPhone = venue.phone || req.body.phone;
    if (!rawPhone) {
      return res.status(422).json({
        error: "No phone number available. Please provide the venue's phone number.",
      });
    }
    const e164phone = toE164(rawPhone);
    if (!e164phone) {
      return res.status(422).json({ error: "Could not parse phone number into a valid format." });
    }
    const phoneUserSupplied = !venue.phone;

    // 5. Rate limit -- one OTP per (user, venue) per 3 minutes
    const threeMinAgo = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: recentClaim } = await supabase
      .from("venue_claims")
      .select("id")
      .eq("venue_id", venueId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .gte("verification_started_at", threeMinAgo)
      .maybeSingle();
    if (recentClaim) {
      return res.status(429).json({ error: "Please wait before requesting another code." });
    }

    // 6. Twilio Lookup -- validate number before sending (~$0.005/call)
    try {
      const lookup = await twilioClient.lookups.v2.phoneNumbers(e164phone).fetch();
      if (!lookup.valid) {
        return res.status(422).json({ error: "Invalid phone number." });
      }
    } catch {
      return res.status(422).json({ error: "Invalid phone number." });
    }

    // 7. Send verification code (Twilio auto-falls back to voice for landlines)
    await verifyService.verifications.create({ to: e164phone, channel: "sms" });

    // 8. Upsert pending claim row
    const now = new Date().toISOString();
    const { error: upsertError } = await supabase
      .from("venue_claims")
      .upsert({
        venue_id:                venueId,
        user_id:                 userId,
        status:                  "pending",
        verified_phone:          e164phone,
        verification_started_at: now,
        submitted_at:            now,
        approved_at:             null,
        is_flagged:              phoneUserSupplied,
        flag_reason:             phoneUserSupplied ? "user-supplied phone number" : null,
      }, { onConflict: 'venue_id, user_id' });
    if (upsertError) throw upsertError;

    return res.json({ success: true, phone_last4: e164phone.slice(-4) });
  } catch (err) {
    console.error("claim/start error:", err);
    res.status(500).json({ error: "Failed to start claim verification. Please try again." });
  }
});

// POST /api/venues/:id/claim/confirm  -- submit OTP code to complete claim
router.post("/:id/claim/confirm", authMiddleware, async (req, res) => {
  try {
    const venueId = req.params.id;
    const userId  = req.user.id;
    const { code } = req.body;

    if (!code) return res.status(400).json({ error: "Verification code is required." });

    // 1. Find the pending claim for this user + venue
    const { data: claim, error: claimError } = await supabase
      .from("venue_claims")
      .select("*")
      .eq("venue_id", venueId)
      .eq("user_id", userId)
      .eq("status", "pending")
      .maybeSingle();
    if (claimError || !claim) {
      return res.status(404).json({ error: "No pending claim found. Please start the claim process first." });
    }

    // 2. TTL -- verification codes expire after 10 minutes
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    if (claim.verification_started_at < tenMinAgo) {
      await supabase
        .from("venue_claims")
        .update({ status: "expired" })
        .eq("id", claim.id);
      return res.status(410).json({
        error: "Verification code expired. Please start the claim process again.",
      });
    }

    // 3. Check OTP with Twilio Verify
    let checkResult;
    try {
      checkResult = await verifyService.verificationChecks.create({
        to:   claim.verified_phone,
        code: String(code),
      });
    } catch {
      return res.status(400).json({ error: "Incorrect verification code." });
    }
    if (checkResult.status !== "approved") {
      return res.status(400).json({ error: "Incorrect verification code." });
    }

    // 4. Auto-flag checks (accumulate; preserve any flag from /start)
    const flagReasons = [];
    if (claim.flag_reason) flagReasons.push(claim.flag_reason);

    // 4a. High claim volume: user would have 4+ approved claims total
    const { count: approvedCount } = await supabase
      .from("venue_claims")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "approved");
    if ((approvedCount || 0) >= 3) {
      flagReasons.push("high claim volume");
    }

    // 4b. Re-claim double-check (belt-and-suspenders)
    const { data: prevApproved } = await supabase
      .from("venue_claims")
      .select("id")
      .eq("venue_id", venueId)
      .eq("status", "approved")
      .neq("user_id", userId)
      .maybeSingle();
    if (prevApproved && !flagReasons.includes("re-claim: venue had previous owner")) {
      flagReasons.push("re-claim: venue had previous owner");
    }

    // 5. Mark claim approved
    const { error: updateClaimError } = await supabase
      .from("venue_claims")
      .update({
        status:      "approved",
        approved_at: new Date().toISOString(),
        is_flagged:  flagReasons.length > 0,
        flag_reason: flagReasons.length > 0 ? flagReasons.join("; ") : null,
      })
      .eq("id", claim.id);
    if (updateClaimError) throw updateClaimError;

    // 6. Update venue -- set owner and mark verified
    const { error: venueUpdateError } = await supabase
      .from("venues")
      .update({ owner_id: userId, is_verified: true })
      .eq("id", venueId);
    if (venueUpdateError) throw venueUpdateError;

    return res.json({ success: true, message: "Venue claimed successfully." });
  } catch (err) {
    console.error("claim/confirm error:", err);
    res.status(500).json({ error: "Failed to confirm claim. Please try again." });
  }
});

// hour_data (BestTime day_raw) is 6am-anchored LOCAL time: index 0 = 6:00am on
// day_int's day, index 23 = 5:00am the NEXT day. Server clock is UTC on Railway.
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function baselinePosition(city, now) {
  const tz = CITY_TIMEZONES[city] || DEFAULT_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(now);
  const localHour = Number(parts.find(p => p.type === "hour").value);
  let dayInt = WEEKDAYS.indexOf(parts.find(p => p.type === "weekday").value);
  let hourIndex;
  if (localHour >= 6) {
    hourIndex = localHour - 6;
  } else {
    // 0:00-5:59am belongs to the previous day's array
    hourIndex = localHour + 18;
    dayInt = (dayInt + 6) % 7;
  }
  return { dayInt, hourIndex, localHour };
}

// GET /api/venues/baseline?city=Charlotte
// or   /api/venues/baseline?swLat=&swLng=&neLat=&neLng=
// The city form must stay supported: App Store build 9 calls it.
router.get("/baseline", async (req, res) => {
  try {
    const { city } = req.query;
    const bounds = parseBounds(req.query);
    if (!city && !bounds) return res.status(400).json({ error: "city or bounds (swLat, swLng, neLat, neLng) required" });
    const now = new Date();

    if (city) {
      const { dayInt, hourIndex, localHour } = baselinePosition(city, now);
      const { data, error } = await supabase
        .from("venue_typical_hours")
        .select(`venue_id, baseline_score:hour_data->>${hourIndex}, venues!inner(city)`)
        .eq("day_int", dayInt)
        .eq("venues.city", city);
      if (error) throw error;
      const baselines = data
        .map(row => ({ venue_id: row.venue_id, baseline_score: Math.round(Number(row.baseline_score) || 0) }));
      return res.json({ day_int: dayInt, hour: localHour, baselines });
    }

    // Bounds mode: venues in view can span timezones, so day_int/hour_index
    // vary per venue's city. Fetch every day_int that any known timezone is
    // currently in (at most 2 distinct values), then filter per row.
    const posByCity = {};
    const positionFor = c => {
      if (!posByCity[c]) posByCity[c] = baselinePosition(c, now);
      return posByCity[c];
    };
    const candidateDayInts = [...new Set(
      [...Object.keys(CITY_TIMEZONES), "__default__"].map(c => positionFor(c).dayInt)
    )];
    const { data, error } = await supabase
      .from("venue_typical_hours")
      .select("venue_id, day_int, hour_data, venues!inner(city, latitude, longitude)")
      .in("day_int", candidateDayInts)
      .gte("venues.latitude", bounds.swLat).lte("venues.latitude", bounds.neLat)
      .gte("venues.longitude", bounds.swLng).lte("venues.longitude", bounds.neLng);
    if (error) throw error;
    const baselines = [];
    for (const row of data) {
      const { dayInt, hourIndex } = positionFor(row.venues.city);
      if (row.day_int !== dayInt) continue;
      const score = Array.isArray(row.hour_data) ? row.hour_data[hourIndex] : null;
      baselines.push({ venue_id: row.venue_id, baseline_score: Math.round(Number(score) || 0) });
    }
    res.json({ baselines });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load baseline scores." });
  }
});

function parseBounds(query) {
  const swLat = parseFloat(query.swLat);
  const swLng = parseFloat(query.swLng);
  const neLat = parseFloat(query.neLat);
  const neLng = parseFloat(query.neLng);
  if (![swLat, swLng, neLat, neLng].every(Number.isFinite)) return null;
  return { swLat, swLng, neLat, neLng };
}

// GET /api/venues/bounds?swLat=&swLng=&neLat=&neLng=&category=
// Assumes swLng <= neLng (no antimeridian crossing — all venues are US East Coast).
router.get("/bounds", async (req, res) => {
  try {
    const bounds = parseBounds(req.query);
    if (!bounds) return res.status(400).json({ error: "swLat, swLng, neLat, neLng are required numbers." });
    const { category } = req.query;
    let query = supabase
      .from("venues")
      .select("id, name, address, neighborhood, city, category, latitude, longitude, description, phone, website, instagram, is_verified, cover_image_url, plan, created_at, venue_busy_scores(busy_score, report_count, last_updated)")
      .gte("latitude", bounds.swLat).lte("latitude", bounds.neLat)
      .gte("longitude", bounds.swLng).lte("longitude", bounds.neLng);
    if (category) query = query.eq("category", category);
    // Cap huge viewports to the busiest venues (ordering is busy_score DESC).
    // 400 > Charlotte's 390 venues, so a single-city view is never truncated.
    query = query.order("venue_busy_scores(busy_score)", { ascending: false, nullsFirst: false }).limit(400);
    const { data, error } = await query;
    if (error) throw error;
    const venues = data.map(v => ({
      ...v,
      busy_score: v.venue_busy_scores?.busy_score ?? 0,
      report_count: v.venue_busy_scores?.report_count ?? 0,
      venue_busy_scores: undefined,
    }));
    res.json(venues);
  } catch (err) {
    console.error("venues/bounds error:", err);
    res.status(500).json({ error: "Failed to load venues." });
  }
});

router.get("/", async (req, res) => {
  try {
    const { city, neighborhood, category } = req.query;
    let query = supabase
      .from("venues")
      .select("id, name, address, neighborhood, city, category, latitude, longitude, description, phone, website, instagram, is_verified, cover_image_url, plan, created_at, venue_busy_scores(busy_score, report_count, last_updated)");
    if (city && city !== "all") query = query.eq("city", city);
    if (neighborhood) query = query.eq("neighborhood", neighborhood);
    if (category) query = query.eq("category", category);
    // referencedTable option only sorts rows inside the embed (no-op for to-one);
    // ordering top-level venues by the embedded column requires this syntax
    query = query.order("venue_busy_scores(busy_score)", { ascending: false, nullsFirst: false }).limit(500);
    const { data, error } = await query;
    if (error) throw error;
    const venues = data.map(v => ({
      ...v,
      busy_score: v.venue_busy_scores?.busy_score ?? 0,
      report_count: v.venue_busy_scores?.report_count ?? 0,
      venue_busy_scores: undefined,
    }));
    // sort handled by SQL ORDER BY on venue_busy_scores.busy_score
    res.json(venues);
  } catch (err) {
    res.status(500).json({ error: "Failed to load venues." });
  }
});

// Google's ToS lets us store place IDs forever but other Places content only
// temporarily — refresh the cached details monthly.
const PLACE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

async function getPlaceData(venue) {
  const { data: cached } = await supabase.from("venue_place_cache").select("*").eq("venue_id", venue.id).maybeSingle();
  const fresh = cached && Date.now() - new Date(cached.fetched_at).getTime() < PLACE_CACHE_TTL_MS;
  if (fresh || !venue.google_place_id || !PLACES_KEY) return cached;
  try {
    const d = await fetchPlaceDetails(venue.google_place_id);
    const row = {
      venue_id: venue.id,
      photos: (d.photos || []).slice(0, 8).map(p => ({
        name: p.name,
        width: p.widthPx,
        height: p.heightPx,
        attribution: p.authorAttributions?.[0]?.displayName || null,
        attribution_uri: p.authorAttributions?.[0]?.uri || null,
      })),
      hours: d.regularOpeningHours
        ? { descriptions: d.regularOpeningHours.weekdayDescriptions || null, periods: d.regularOpeningHours.periods || null }
        : null,
      phone: d.nationalPhoneNumber || null,
      website: d.websiteUri || null,
      google_maps_uri: d.googleMapsUri || null,
      editorial_summary: d.editorialSummary?.text || null,
      fetched_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("venue_place_cache").upsert(row);
    if (error) throw error;
    return row;
  } catch (err) {
    console.error("place details fetch failed:", err.message);
    return cached; // stale beats nothing
  }
}

async function getFriendsHere(userId, venueId) {
  const { data: friendships } = await supabase
    .from("friendships")
    .select("requester_id, addressee_id")
    .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
    .eq("status", "accepted");
  const friendIds = (friendships || []).map(f => (f.requester_id === userId ? f.addressee_id : f.requester_id));
  if (!friendIds.length) return [];
  const staleCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: locs, error } = await supabase
    .from("friend_locations")
    .select("user_id, updated_at, users!inner(id, username, display_name, avatar_url, location_sharing)")
    .eq("venue_id", venueId)
    .in("user_id", friendIds)
    .gte("updated_at", staleCutoff)
    .eq("users.location_sharing", true);
  if (error) throw error;
  return (locs || []).map(l => ({
    id: l.users.id,
    username: l.users.username,
    display_name: l.users.display_name,
    avatar_url: l.users.avatar_url,
  }));
}

// GET /api/venues/:id
router.get("/:id", async (req, res) => {
  try {
    const { data: venue, error } = await supabase.from("venues").select("*, venue_busy_scores(busy_score, report_count)").eq("id", req.params.id).single();
    if (error) return res.status(404).json({ error: "Venue not found." });
    const now = new Date();
    const { dayInt, hourIndex } = baselinePosition(venue.city, now);

    const [place, { data: deals }, { data: events }, { data: stories }, { data: typical }, friendsHere] = await Promise.all([
      getPlaceData(venue),
      supabase.from("deals").select("*").eq("venue_id", req.params.id).eq("is_active", true).gt("expires_at", now.toISOString()),
      supabase.from("events").select("*, event_deals(deals(id, title, detail, description, tags, is_premium_only, is_active, expires_at, recur_days, recur_start, recur_end, source))").eq("venue_id", req.params.id).eq("is_active", true),
      supabase.from("stories").select("id, caption, emoji, visibility, is_anonymous, like_count, created_at, users!stories_user_id_fkey(username, display_name, avatar_url)").eq("venue_id", req.params.id).eq("visibility", "public").gt("expires_at", now.toISOString()).order("created_at", { ascending: false }).limit(10),
      supabase.from("venue_typical_hours").select("day_int, hour_data").eq("venue_id", req.params.id).eq("day_int", dayInt).maybeSingle(),
      (async () => {
        const authHeader = req.headers.authorization;
        if (!authHeader?.startsWith("Bearer ")) return null;
        try {
          const user = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
          return await getFriendsHere(user.id, req.params.id);
        } catch { return null; }
      })(),
    ]);

    // Explicit public shape — never spread the venue row here (it carries
    // owner_id, stripe_customer_id, google_place_id).
    const { id, name, address, neighborhood, city, category, latitude, longitude,
      description, phone, website, instagram, is_verified, cover_image_url, plan,
      heatmap_boost, created_at } = venue;
    res.json({
      id, name, address, neighborhood, city, category, latitude, longitude,
      description, phone, website, instagram, is_verified, cover_image_url, plan,
      heatmap_boost, created_at,
      is_claimed: !!venue.owner_id,
      busy_score: venue.venue_busy_scores?.busy_score ?? 0,
      report_count: venue.venue_busy_scores?.report_count ?? 0,
      deals: (deals || []).map(d => ({ ...d, is_live_now: isDealLiveNow({ ...d, venues: { city: venue.city } }, now) })),
      events: (events || [])
        .map(e => {
          const fromStr = cityNow(venue.city, now).dateStr;
          return shapeEvent({ ...e, venues: { city: venue.city } }, fromStr, addDays(fromStr, 30), now);
        })
        .filter(e => e.occurrences.length > 0)
        .sort((a, b) => (b.is_now - a.is_now) || a.next_occurrence.localeCompare(b.next_occurrence))
        .map(e => ({ ...e, venues: undefined })),
      stories: stories || [],
      place: place
        ? {
            photos: (place.photos || []).map((p, i) => ({ index: i, width: p.width, height: p.height, attribution: p.attribution, attribution_uri: p.attribution_uri })),
            hours: place.hours,
            phone: place.phone,
            website: place.website,
            google_maps_uri: place.google_maps_uri,
            editorial_summary: place.editorial_summary,
          }
        : null,
      typical_today: typical ? { day_int: typical.day_int, hour_data: typical.hour_data, now_index: hourIndex } : null,
      friends_here: friendsHere,
    });
  } catch (err) {
    console.error("venue detail error:", err);
    res.status(500).json({ error: "Failed to load venue." });
  }
});

// GET /api/venues/:id/photos/:idx — 302 to the Google-hosted image; the
// resolved URL is cached in-process so repeat views don't bill.
router.get("/:id/photos/:idx", async (req, res) => {
  try {
    const idx = Number(req.params.idx);
    const { data: cache } = await supabase.from("venue_place_cache").select("photos").eq("venue_id", req.params.id).maybeSingle();
    const photo = Array.isArray(cache?.photos) ? cache.photos[idx] : null;
    if (!photo?.name) return res.status(404).json({ error: "Photo not found." });
    const uri = await resolvePhotoUri(photo.name);
    if (!uri) return res.status(404).json({ error: "Photo not available." });
    res.redirect(302, uri);
  } catch (err) {
    console.error("venue photo error:", err.message);
    res.status(500).json({ error: "Failed to load photo." });
  }
});

// POST /api/venues/:id/crowd
router.post("/:id/crowd", authMiddleware, crowdReportLimiter, async (req, res) => {
  try {
    const { busy_level } = req.body;
    if (typeof busy_level !== "number" || busy_level < 0 || busy_level > 100) return res.status(400).json({ error: "busy_level must be a number between 0-100." });
    await supabase.from("crowd_reports").insert({ venue_id: req.params.id, user_id: req.user.id, busy_level });
    const { data: scores } = await supabase.from("crowd_reports").select("busy_level").eq("venue_id", req.params.id).gt("reported_at", new Date(Date.now() - 90 * 60 * 1000).toISOString());
    const avg = scores.reduce((sum, r) => sum + r.busy_level, 0) / scores.length;
    await supabase.from("venue_busy_scores").upsert({ venue_id: req.params.id, busy_score: Math.round(avg), report_count: scores.length, last_updated: new Date().toISOString() });
    await supabase.from("busy_score_history").insert({ venue_id: req.params.id, busy_score: Math.round(avg), recorded_at: new Date().toISOString() });
    // visitor_count is now incremented by the venue_visit event in friends.js
    // (check-in / GPS proximity), so crowd reports no longer bump it here —
    // that would double-count a report+check-in pair.
    res.json({ success: true, new_score: Math.round(avg) });
  } catch (err) {
    console.error("crowd report error:", err);
    res.status(500).json({ error: "Failed to submit crowd report." });
  }
});

// POST /api/venues  (create)
router.post("/", authMiddleware, async (req, res) => {
  try {
    const { name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram } = req.body;
    if (!name || !address || !neighborhood || !latitude || !longitude) return res.status(400).json({ error: "name, address, neighborhood, latitude, longitude are required." });
    const { data, error } = await supabase.from("venues").insert({ name, address, neighborhood, latitude, longitude, category, description, phone, website, instagram, owner_id: req.user.id }).select().single();
    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to create venue." });
  }
});

// PATCH /api/venues/:id
router.patch("/:id", authMiddleware, async (req, res) => {
  const { data: venue } = await supabase.from("venues").select("owner_id").eq("id", req.params.id).single();
  if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
  const allowed = ["name", "description", "address", "phone", "website", "instagram", "cover_image_url"];
  const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
 
  const { data } = await supabase.from("venues").update(updates).eq("id", req.params.id).select().single();
  res.json(data);
});

module.exports = router;
