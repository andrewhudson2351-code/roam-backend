// Scheduled marketing pushes. An hourly cron calls run(); each SCHEDULE entry
// fires when a city's LOCAL day/hour matches, so Nashville (Central) lags the
// Eastern cities by an hour automatically. Users are grouped by the city they
// are actually in (fresh location signal), not just home_city. The dailyCap in
// sendMarketingPush makes accidental re-runs within the same day harmless.
const { supabase } = require("../config/supabase");
const { sendMarketingPush, localHour } = require("../marketing");
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");

const SCHEDULE = [
  { kind: "taco_tuesday", dow: 2, hour: 16, tag: "Tacos", title: "Taco Tuesday 🌮",
    body: (n, city) => `${n} taco deal${n > 1 ? "s" : ""} live in ${city} tonight. See the map.` },
  { kind: "wing_night", dow: 3, hour: 16, tag: "Wings", title: "Wing night 🍗",
    body: (n, city, top) => n > 1 ? `${top} and ${n - 1} more near you tonight.` : `${top} — tonight in ${city}.` },
  { kind: "happy_hour", dow: 4, hour: 17, tag: "Happy Hour", title: "Happy hour 🍸",
    body: (n, city, top) => n > 1 ? `${n} happy hours on in ${city} tonight. See the map.` : `${top} — tonight in ${city}.` },
  { kind: "friday_kickoff", dow: 5, hour: 19, tag: null, title: "It's Friday 🍺",
    body: (n, city) => `See what's busy in ${city} right now — and who's out.` },
  { kind: "sunday_brunch", dow: 0, hour: 10, tag: "Brunch", title: "Sunday brunch 🥂",
    body: (n, city) => `${n} brunch deal${n > 1 ? "s" : ""} in ${city} today. Don't sleep in too long.` },
];

function localDow(city, now) {
  const tz = CITY_TIMEZONES[city] || DEFAULT_TIMEZONE;
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(now));
}

// Resolve each opted-in user's CURRENT city — freshest signal wins: last
// check-in venue's city, else last GPS ping matched to the nearest venue
// (25 km), else home_city. No fresh signal and no home_city = not targeted.
const FRESH_DAYS = 14;
async function resolveCities(users) {
  const ids = users.map((u) => u.id);
  const { data: locs } = await supabase.from("friend_locations")
    .select("user_id, venue_id, latitude, longitude, updated_at").in("user_id", ids);
  const cutoff = Date.now() - FRESH_DAYS * 86400000;
  const fresh = (locs || []).filter((l) => new Date(l.updated_at).getTime() > cutoff);
  const venueIds = [...new Set(fresh.map((l) => l.venue_id).filter(Boolean))];
  const cityByVenue = {};
  if (venueIds.length) {
    const { data: vs } = await supabase.from("venues").select("id, city").in("id", venueIds);
    for (const v of vs || []) cityByVenue[v.id] = v.city;
  }
  const byCity = {};
  for (const u of users) {
    const loc = fresh.find((l) => l.user_id === u.id);
    let city = loc?.venue_id ? cityByVenue[loc.venue_id] : null;
    if (!city && loc?.latitude != null) {
      const { data: vid } = await supabase.rpc("find_nearby_venue",
        { p_lat: loc.latitude, p_lng: loc.longitude, p_radius_m: 25000 });
      if (vid) city = (await supabase.from("venues").select("city").eq("id", vid).single()).data?.city;
    }
    city = city || u.home_city;
    if (city) (byCity[city] ||= []).push(u.id);
  }
  return byCity;
}

async function run(now = new Date()) {
  const { data: users } = await supabase.from("users")
    .select("id, home_city").eq("notify_deals", true);
  if (!users?.length) return 0;
  const byCity = await resolveCities(users);

  let sent = 0;
  for (const [city, userIds] of Object.entries(byCity)) {
    const dow = localDow(city, now), hour = localHour(city, now);
    for (const s of SCHEDULE) {
      if (s.dow !== dow || s.hour !== hour) continue;
      let n = 0, top = null;
      if (s.tag) {
        const { data: deals } = await supabase.from("deals")
          .select("title, recur_days, venues!inner(city)")
          .eq("is_active", true).gt("expires_at", now.toISOString())
          .contains("tags", [s.tag]).eq("venues.city", city);
        const todays = (deals || []).filter((d) => !d.recur_days || d.recur_days.includes(dow));
        n = todays.length;
        if (!n) continue; // no matching deals today -> no push in this city
        top = todays[0].title;
      }
      for (const uid of userIds) {
        if (await sendMarketingPush(uid, {
          kind: s.kind, dailyCap: true,
          title: s.title, body: s.body(n, city, top),
          data: { type: s.kind, city },
        })) sent++;
      }
    }
  }
  return sent;
}

module.exports = run;
