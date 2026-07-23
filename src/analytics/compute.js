// Venue analytics breakout: assembles baseline (BestTime typical hours),
// reported busyness (crowd reports, owner vs consumer), a 7-day summary with
// deal overlays, and the per-deal funnel (clicks -> redemptions -> visits).
// Used by GET /api/analytics/venue/:id and the weekly owner digest email.
//
// Conventions (must match venue_typical_hours + venues.js baselinePosition):
// hour_data is 6am-anchored LOCAL time — index 0 = 6:00, index 23 = 5:00 next
// day; day_int 0 = Monday. Confirmed visits are aggregate COUNTS only — no
// user identity ever leaves this module.

const { supabase } = require("../config/supabase");
const { CITY_TIMEZONES, DEFAULT_TIMEZONE } = require("../config/timezones");

const DAY_TEXT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WD_MAP = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const VISIT_WINDOW_H = 48; // deal_click -> venue_visit attribution window
const EVENING_IDX = [12, 13, 14, 15, 16, 17, 18, 19, 20]; // 6pm..2am, chart indexes

// Estimated visitation: a DIRECTIONAL model, not a measured count (always
// present it with a footnote). evening busy% x a typical capacity for the
// venue's category x evening crowd turnover.
const CATEGORY_CAPACITY = { Club: 150, Bar: 80, Restaurant: 70, Venue: 120, Event: 100 };
const CROWD_TURNS = 2.5;
function estimateVisitors(category, busyPct) {
  if (busyPct == null) return null;
  const cap = CATEGORY_CAPACITY[category] || 80;
  return Math.round((cap * busyPct * CROWD_TURNS) / 100);
}

function localParts(date, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    dow: WD_MAP[get("weekday")], // 0=Mon..6=Sun
    hour: Number(get("hour")) % 24,
    date: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

// Map a timestamp to its 6am-anchored chart slot: hours 0-5 belong to the
// PREVIOUS day's night.
function chartSlot(date, tz) {
  const p = localParts(date, tz);
  if (p.hour < 6) return { day: (p.dow + 6) % 7, idx: p.hour + 18 };
  return { day: p.dow, idx: p.hour - 6 };
}

async function computeVenueAnalytics(venueId) {
  const { data: venue, error: vErr } = await supabase
    .from("venues")
    .select("id, name, city, neighborhood, owner_id, category")
    .eq("id", venueId).single();
  if (vErr || !venue) throw new Error("Venue not found");
  const tz = CITY_TIMEZONES[venue.city] || DEFAULT_TIMEZONE;
  const now = new Date();
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

  const [hoursQ, crowdQ, historyQ, dealsQ, eventsQ, storiesQ] = await Promise.all([
    supabase.from("venue_typical_hours").select("day_int, hour_data").eq("venue_id", venueId),
    supabase.from("crowd_reports").select("user_id, busy_level, reported_at").eq("venue_id", venueId).gte("reported_at", iso(28)),
    supabase.from("busy_score_history").select("busy_score, recorded_at").eq("venue_id", venueId).gte("recorded_at", iso(7)),
    supabase.from("deals").select("id, title, recur_days, source, is_active, redemption_count, expires_at").eq("venue_id", venueId),
    supabase.from("analytics_events").select("event_type, deal_id, user_id, created_at").eq("venue_id", venueId).gte("created_at", iso(30)),
    supabase.from("stories").select("id, created_at").eq("venue_id", venueId).gte("created_at", iso(7)),
  ]);
  const typicalRows = hoursQ.data || [];
  const crowd = crowdQ.data || [];
  const history = historyQ.data || [];
  const deals = dealsQ.data || [];
  const events = eventsQ.data || [];
  const stories = storiesQ.data || [];

  const dealIds = deals.map((d) => d.id);
  const [redemptionsQ, savesQ] = await Promise.all([
    dealIds.length
      ? supabase.from("deal_redemptions").select("deal_id, redeemed_at").in("deal_id", dealIds)
      : Promise.resolve({ data: [] }),
    dealIds.length
      ? supabase.from("deal_saves").select("deal_id").in("deal_id", dealIds)
      : Promise.resolve({ data: [] }),
  ]);
  const redemptions = redemptionsQ.data || [];
  const saves = savesQ.data || [];

  // baseline[7][24] — null where unknown
  const baseline = Array.from({ length: 7 }, () => Array(24).fill(null));
  for (const r of typicalRows) {
    if (r.day_int >= 0 && r.day_int < 7 && Array.isArray(r.hour_data)) baseline[r.day_int] = r.hour_data;
  }

  // reported[7][24] — {consumer_avg, consumer_n, owner_n} from 28d of crowd reports
  const acc = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ sum: 0, n: 0, ownerN: 0 })));
  for (const r of crowd) {
    const { day, idx } = chartSlot(new Date(r.reported_at), tz);
    const cell = acc[day][idx];
    if (r.user_id === venue.owner_id) cell.ownerN++;
    else { cell.sum += r.busy_level; cell.n++; }
  }
  const reported = acc.map((dayArr) =>
    dayArr.map((c) => ({
      consumer_avg: c.n ? Math.round(c.sum / c.n) : null,
      consumer_n: c.n,
      owner_n: c.ownerN,
    }))
  );

  // Last 7 local dates, oldest first
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now - i * 86400000);
    const p = localParts(d, tz);
    days.push({ date: p.date, dow: p.dow, jsDow: (p.dow + 1) % 7 }); // jsDow: 0=Sun for recur_days
  }
  const byDate = Object.fromEntries(days.map((d) => [d.date, {
    date: d.date, day_text: DAY_TEXT[d.dow], dow: d.dow,
    busySum: 0, busyN: 0, peak: 0, eveSum: 0, eveN: 0,
    views: 0, visits: 0, clicks: 0, redemptions: 0,
    deals: deals.filter((dl) => Array.isArray(dl.recur_days) && dl.recur_days.includes(d.jsDow)).map((dl) => dl.title),
  }]));
  for (const h of history) {
    const p = localParts(new Date(h.recorded_at), tz);
    const day = byDate[p.date];
    if (!day) continue;
    day.busySum += h.busy_score; day.busyN++;
    day.peak = Math.max(day.peak, h.busy_score);
    const slot = chartSlot(new Date(h.recorded_at), tz);
    if (EVENING_IDX.includes(slot.idx)) { day.eveSum += h.busy_score; day.eveN++; }
  }
  for (const e of events) {
    const p = localParts(new Date(e.created_at), tz);
    const day = byDate[p.date];
    if (!day) continue;
    if (e.event_type === "venue_view") day.views++;
    else if (e.event_type === "venue_visit") day.visits++;
    else if (e.event_type === "deal_click") day.clicks++;
  }
  for (const r of redemptions) {
    const p = localParts(new Date(r.redeemed_at), tz);
    if (byDate[p.date]) byDate[p.date].redemptions++;
  }
  // Baseline evening average per weekday, for "vs typical" deltas
  const baselineEvening = baseline.map((hours) => {
    const vals = EVENING_IDX.map((i) => hours[i]).filter((v) => v != null);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  });
  const weekly = days.map((d) => {
    const w = byDate[d.date];
    const avg_busy = w.busyN ? Math.round(w.busySum / w.busyN) : null;
    const evening_busy = w.eveN ? Math.round(w.eveSum / w.eveN) : null;
    const typical = baselineEvening[w.dow];
    return {
      date: w.date, day_text: w.day_text,
      avg_busy, peak_busy: w.busyN ? w.peak : null, evening_busy,
      typical_evening: typical,
      delta_pct: evening_busy != null && typical ? Math.round(((evening_busy - typical) / typical) * 100) : null,
      est_visitors: estimateVisitors(venue.category, evening_busy ?? typical),
      views: w.views, visits: w.visits, clicks: w.clicks, redemptions: w.redemptions,
      deals: w.deals,
    };
  });
  const estimated_visitors_7d = weekly.some((w) => w.est_visitors != null)
    ? weekly.reduce((s, w) => s + (w.est_visitors || 0), 0)
    : null;

  // Per-deal funnel. Confirmed visits: distinct users whose deal_click was
  // followed by a venue_visit at this venue within VISIT_WINDOW_H. Counts only.
  const visitsByUser = new Map();
  for (const e of events) {
    if (e.event_type === "venue_visit" && e.user_id) {
      if (!visitsByUser.has(e.user_id)) visitsByUser.set(e.user_id, []);
      visitsByUser.get(e.user_id).push(new Date(e.created_at).getTime());
    }
  }
  const savesByDeal = {};
  for (const s of saves) savesByDeal[s.deal_id] = (savesByDeal[s.deal_id] || 0) + 1;
  const funnel = deals
    .map((d) => {
      const clicks = events.filter((e) => e.event_type === "deal_click" && e.deal_id === d.id);
      const clickUsers = new Set(clicks.filter((e) => e.user_id).map((e) => e.user_id));
      let confirmed = 0;
      for (const uid of clickUsers) {
        const clickTimes = clicks.filter((e) => e.user_id === uid).map((e) => new Date(e.created_at).getTime());
        const visits = visitsByUser.get(uid) || [];
        if (clickTimes.some((ct) => visits.some((vt) => vt > ct && vt - ct <= VISIT_WINDOW_H * 3600000))) confirmed++;
      }
      return {
        deal_id: d.id, title: d.title, source: d.source, is_active: d.is_active,
        clicks_30d: clicks.length,
        redemptions_total: d.redemption_count || 0,
        saves_total: savesByDeal[d.id] || 0,
        confirmed_visits_30d: confirmed,
      };
    })
    .sort((a, b) => b.clicks_30d + b.redemptions_total - (a.clicks_30d + a.redemptions_total));

  const totals7 = weekly.reduce(
    (t, w) => ({
      views: t.views + w.views, visits: t.visits + w.visits,
      clicks: t.clicks + w.clicks, redemptions: t.redemptions + w.redemptions,
    }),
    { views: 0, visits: 0, clicks: 0, redemptions: 0 }
  );
  const busiest = weekly.filter((w) => w.evening_busy != null).sort((a, b) => b.evening_busy - a.evening_busy)[0] || null;

  return {
    venue: { id: venue.id, name: venue.name, city: venue.city, neighborhood: venue.neighborhood, category: venue.category },
    timezone: tz,
    baseline,           // [7][24] typical busyness, day 0=Mon, idx 0=6am local
    reported,           // [7][24] {consumer_avg, consumer_n, owner_n} last 28d
    weekly,             // last 7 days, oldest first
    funnel,             // per-deal, sorted by activity
    totals_7d: { ...totals7, stories: stories.length },
    estimated_visitors_7d, // directional model — surface only with a footnote
    busiest_night: busiest ? { day_text: busiest.day_text, evening_busy: busiest.evening_busy } : null,
  };
}

// ---------- weekly digest email ----------

const GOLD = "#C8A96E", IVORY = "#E8D5A3", CARBON = "#1C1C1C", MUTED = "#6B7280";

function digestBars(weekly) {
  const max = Math.max(1, ...weekly.map((w) => w.evening_busy ?? 0));
  const cols = weekly
    .map((w) => {
      const v = w.evening_busy ?? 0;
      const h = Math.max(3, Math.round((v / max) * 72));
      const bullet = w.deals.length ? `<div style="font-size:10px;line-height:1;color:${IVORY};padding-top:3px" title="${w.deals.join(", ")}">&#9679;</div>` : `<div style="height:13px"></div>`;
      return `<td align="center" valign="bottom" style="padding:0 5px">
        <div style="font-size:10px;color:#999;padding-bottom:3px">${v ? v : ""}</div>
        <div style="width:26px;height:${h}px;background:${v ? GOLD : "#3A3A3A"};border-radius:4px 4px 0 0"></div>
        ${bullet}
        <div style="font-size:11px;color:#BBB;padding-top:4px">${w.day_text}</div>
      </td>`;
    })
    .join("");
  return `<table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto"><tr>${cols}</tr></table>
    <div style="font-size:11px;color:#888;text-align:center;padding-top:6px">Evening busyness by night &nbsp;&#9679;&nbsp; = deal running</div>`;
}

function tile(label, value) {
  return `<td align="center" style="background:#262626;border:1px solid #3A3A3A;border-radius:12px;padding:14px 6px">
    <div style="font-size:22px;font-weight:bold;color:${GOLD};font-family:Georgia,serif">${value}</div>
    <div style="font-size:10px;color:#999;letter-spacing:1px;padding-top:4px">${label.toUpperCase()}</div>
  </td>`;
}

function renderDigestHtml(a) {
  const t = a.totals_7d;
  const topDeal = a.funnel[0];
  const best = a.weekly.filter((w) => w.delta_pct != null).sort((x, y) => y.delta_pct - x.delta_pct)[0];
  return `<div style="font-family:Georgia,serif;background:${CARBON};color:#FAFAF8;padding:32px;border-radius:12px;max-width:520px;margin:0 auto">
    <h1 style="color:${GOLD};letter-spacing:3px;font-size:22px;margin:0 0 4px">ROAMAN</h1>
    <p style="font-size:13px;color:#999;margin:0 0 20px">Weekly report &middot; ${a.venue.name}</p>
    <table cellpadding="0" cellspacing="6" border="0" width="100%"><tr>
      ${tile("Profile views", t.views)}
      ${tile("Visits", t.visits)}
      ${tile("Redemptions", t.redemptions)}
    </tr></table>
    <div style="padding:22px 0 8px">${digestBars(a.weekly)}</div>
    ${a.estimated_visitors_7d != null ? `<p style="font-size:14px;margin:16px 0 4px">Estimated visitation this week: <strong style="color:${GOLD}">~${a.estimated_visitors_7d.toLocaleString()}</strong> guests*</p>` : ""}
    ${a.busiest_night ? `<p style="font-size:14px;margin:${a.estimated_visitors_7d != null ? "4px" : "16px"} 0 4px">Your busiest night was <strong style="color:${GOLD}">${a.busiest_night.day_text}</strong>.</p>` : ""}
    ${best && best.delta_pct > 0 ? `<p style="font-size:14px;margin:4px 0">${best.day_text} ran <strong style="color:${GOLD}">+${best.delta_pct}%</strong> above your typical ${best.day_text}${best.deals.length ? ` — ${best.deals[0]} was live` : ""}.</p>` : ""}
    ${topDeal && (topDeal.clicks_30d || topDeal.redemptions_total) ? `<p style="font-size:14px;margin:4px 0 16px">Top deal: <strong style="color:${IVORY}">${topDeal.title}</strong> — ${topDeal.clicks_30d} views, ${topDeal.redemptions_total} redemptions.</p>` : ""}
    <p style="margin:24px 0 0"><a href="https://app.roaman.app" style="background:${GOLD};color:${CARBON};padding:12px 24px;border-radius:10px;text-decoration:none;font-weight:bold">Open your dashboard</a></p>
    ${a.estimated_visitors_7d != null ? `<p style="font-size:11px;color:#777;margin-top:20px">*Estimated visitation is a directional model — typical and reported busyness applied to a typical capacity for ${a.venue.category || "similar"} venues — not a measured count of guests.</p>` : ""}
    <p style="font-size:11px;color:#777;margin-top:${a.estimated_visitors_7d != null ? "6px" : "20px"}">Visit counts are anonymous aggregates from users who opted into location sharing. Numbers grow as more Roamers use the app in ${a.venue.city}.</p>
  </div>`;
}

module.exports = { computeVenueAnalytics, renderDigestHtml };
