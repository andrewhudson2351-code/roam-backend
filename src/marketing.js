// Marketing pushes: everything here respects users.notify_deals (opt-in,
// Apple guideline 4.5.4) and the push_log dedupe rules. Social pushes go
// through notify.js directly and are NOT gated by notify_deals.
const { supabase } = require("./config/supabase");
const { notifyUser } = require("./notify");
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("./config/timezones");

// dailyCap: max one push of this kind per user per 24h.
// dedupeDays: never repeat the same kind+ref_id within N days.
async function sendMarketingPush(userId, { kind, refId = null, dailyCap = false, dedupeDays = 0, title, body, data }) {
  const { data: u } = await supabase.from("users").select("notify_deals").eq("id", userId).single();
  if (!u?.notify_deals) return false;
  if (dailyCap) {
    const since = new Date(Date.now() - 24 * 3600000).toISOString();
    const { data: hit } = await supabase.from("push_log").select("id")
      .eq("user_id", userId).eq("kind", kind).gte("sent_at", since).limit(1);
    if (hit?.length) return false;
  }
  if (dedupeDays && refId) {
    const since = new Date(Date.now() - dedupeDays * 86400000).toISOString();
    const { data: hit } = await supabase.from("push_log").select("id")
      .eq("user_id", userId).eq("kind", kind).eq("ref_id", refId).gte("sent_at", since).limit(1);
    if (hit?.length) return false;
  }
  await supabase.from("push_log").insert({ user_id: userId, kind, ref_id: refId });
  notifyUser(userId, { title, body, data });
  return true;
}

function localHour(city, now = new Date()) {
  const tz = CITY_TIMEZONES[city] || DEFAULT_TIMEZONE;
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" })
    .formatToParts(now).find((p) => p.type === "hour").value);
}

// Deal nearby — called from the GPS ping path. 150m radius, 11:00-23:00
// local only, max one per day, and the same deal never repeats inside 7 days.
async function pushNearbyDeal(userId, explicitVenueId, lat, lng) {
  let venueId = explicitVenueId;
  if (!venueId && lat != null && lng != null) {
    const { data } = await supabase.rpc("find_nearby_venue", { p_lat: lat, p_lng: lng, p_radius_m: 150 });
    venueId = data;
  }
  if (!venueId) return;
  const { data: deals } = await supabase.from("deals")
    .select("*, venues(id, name, city)")
    .eq("venue_id", venueId).eq("is_active", true).gt("expires_at", new Date().toISOString());
  const { isDealLiveNow } = require("./routes/deals"); // lazy: routes/deals requires this module
  const live = (deals || []).filter((d) => isDealLiveNow(d));
  if (!live.length) return;
  const h = localHour(live[0].venues.city);
  if (h < 11 || h >= 23) return;
  const deal = live[0];
  await sendMarketingPush(userId, {
    kind: "deal_nearby", refId: deal.id, dailyCap: true, dedupeDays: 7,
    title: "Deal nearby 📍",
    body: `${deal.venues.name}: ${deal.title} — you're steps away`,
    data: { type: "deal_nearby", venue_id: venueId, deal_id: deal.id },
  });
}

// Owner-facing push: about THEIR venue, so not gated on notify_deals.
// push_log still dedupes so a busy night can't spam the owner.
async function sendOwnerPush(userId, { kind, refId = null, dedupeDays = 0, title, body, data }) {
  if (dedupeDays && refId) {
    const since = new Date(Date.now() - dedupeDays * 86400000).toISOString();
    const { data: hit } = await supabase.from("push_log").select("id")
      .eq("user_id", userId).eq("kind", kind).eq("ref_id", refId).gte("sent_at", since).limit(1);
    if (hit?.length) return false;
  }
  await supabase.from("push_log").insert({ user_id: userId, kind, ref_id: refId });
  notifyUser(userId, { title, body, data });
  return true;
}

// New deal at your spot — owner posts a deal, users with a venue_visit there
// in the last 30 days OR the venue favorited hear about it. Max one per venue
// per week per user.
async function pushNewDealToRecentVisitors(deal) {
  const { data: venue } = await supabase.from("venues").select("id, name, city").eq("id", deal.venue_id).single();
  if (!venue) return;
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const [{ data: visits }, { data: favs }] = await Promise.all([
    supabase.from("analytics_events")
      .select("user_id").eq("venue_id", deal.venue_id).eq("event_type", "venue_visit")
      .gte("created_at", since).not("user_id", "is", null),
    supabase.from("venue_favorites").select("user_id").eq("venue_id", deal.venue_id),
  ]);
  const userIds = [...new Set([...(visits || []), ...(favs || [])].map((v) => v.user_id))];
  for (const uid of userIds) {
    await sendMarketingPush(uid, {
      kind: "venue_new_deal", refId: venue.id, dedupeDays: 7,
      title: `${venue.name} just posted a deal`,
      body: deal.title,
      data: { type: "venue_new_deal", venue_id: venue.id, deal_id: deal.id },
    });
  }
}

module.exports = { sendMarketingPush, sendOwnerPush, pushNearbyDeal, pushNewDealToRecentVisitors, localHour };
