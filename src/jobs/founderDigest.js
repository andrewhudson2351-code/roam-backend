// Weekly founder metrics email — the "is this actually working?" numbers that
// owner analytics don't show you: growth, active users, retention, and where
// real (user-generated) activity is happening vs. where it's a ghost town.
// Sends to FOUNDER_EMAIL (default dev@roaman.app); no-op logging if RESEND
// isn't configured. Runs weekly via cron in index.js.
const { supabase } = require("../config/supabase");

const GOLD = "#C8A96E", CARBON = "#1C1C1C", INK = "#FAFAF8", MUTED = "#8A7E6A";
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

// Distinct users who did anything user-attributed (analytics event or crowd
// report) since `sinceIso`.
async function activeUsers(sinceIso) {
  const [{ data: ev }, { data: cr }] = await Promise.all([
    supabase.from("analytics_events").select("user_id").gte("created_at", sinceIso).not("user_id", "is", null),
    supabase.from("crowd_reports").select("user_id").gte("reported_at", sinceIso).not("user_id", "is", null),
  ]);
  const s = new Set();
  for (const r of ev || []) s.add(r.user_id);
  for (const r of cr || []) s.add(r.user_id);
  return s;
}

async function computeFounderMetrics() {
  const [{ count: totalUsers }, { count: newUsers7d }, { count: newUsers30d },
         active1d, active7d, active30dSet, active7dPrevSet,
         { count: crowd7d }, { count: activeDeals }, { count: activeEvents },
         { count: claimedVenues }, { count: totalVenues }, { count: devices }] = await Promise.all([
    supabase.from("users").select("*", { count: "exact", head: true }),
    supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", iso(7)),
    supabase.from("users").select("*", { count: "exact", head: true }).gte("created_at", iso(30)),
    activeUsers(iso(1)),
    activeUsers(iso(7)),
    activeUsers(iso(30)),
    activeUsers(iso(14)), // for a rough WoW retention read (prev week's actives)
    supabase.from("crowd_reports").select("*", { count: "exact", head: true }).gte("reported_at", iso(7)),
    supabase.from("deals").select("*", { count: "exact", head: true }).eq("is_active", true).gt("expires_at", new Date().toISOString()),
    supabase.from("events").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("venues").select("*", { count: "exact", head: true }).not("owner_id", "is", null),
    supabase.from("venues").select("*", { count: "exact", head: true }),
    supabase.from("device_tokens").select("*", { count: "exact", head: true }),
  ]);

  // Where is the LIVE (user-generated) activity? Crowd reports by city, last 7d.
  const { data: reports } = await supabase.from("crowd_reports")
    .select("venue_id, venues(city)").gte("reported_at", iso(7));
  const cityReports = {};
  for (const r of reports || []) { const c = r.venues?.city; if (c) cityReports[c] = (cityReports[c] || 0) + 1; }
  const topCities = Object.entries(cityReports).sort((a, b) => b[1] - a[1]).slice(0, 6);

  return {
    totalUsers: totalUsers || 0, newUsers7d: newUsers7d || 0, newUsers30d: newUsers30d || 0,
    active1d: active1d.size, active7d: active7d.size, active30d: active30dSet.size,
    crowd7d: crowd7d || 0, activeDeals: activeDeals || 0, activeEvents: activeEvents || 0,
    claimedVenues: claimedVenues || 0, totalVenues: totalVenues || 0, devices: devices || 0,
    topCities,
  };
}

function tile(label, value, sub) {
  return `<td align="center" style="background:#262626;border:1px solid #3A3A3A;border-radius:12px;padding:14px 8px">
    <div style="font-size:24px;font-weight:bold;color:${GOLD};font-family:Georgia,serif">${value}</div>
    <div style="font-size:9px;color:#999;letter-spacing:1px;padding-top:4px;text-transform:uppercase">${label}</div>
    ${sub ? `<div style="font-size:9px;color:${MUTED};padding-top:2px">${sub}</div>` : ""}</td>`;
}

function renderFounderDigestHtml(m) {
  const cityRows = m.topCities.length
    ? m.topCities.map(([c, n]) => `<tr><td style="padding:4px 0;color:${INK};font-size:13px">${c}</td><td align="right" style="color:${GOLD};font-size:13px">${n} reports</td></tr>`).join("")
    : `<tr><td style="color:${MUTED};font-size:12px;padding:4px 0">No crowd reports this week — the map is running on baselines/scraped data only.</td></tr>`;
  return `<div style="font-family:Georgia,serif;background:${CARBON};color:${INK};padding:32px;border-radius:12px;max-width:560px;margin:0 auto">
    <h1 style="color:${GOLD};letter-spacing:3px;font-size:22px;margin:0 0 2px">ROAMAN</h1>
    <p style="font-size:13px;color:#999;margin:0 0 20px">Founder report · week ending ${new Date().toLocaleDateString()}</p>

    <div style="font-size:10px;color:${GOLD};letter-spacing:2px;text-transform:uppercase;margin-bottom:8px">Demand — the number that matters</div>
    <table cellpadding="0" cellspacing="6" border="0" width="100%"><tr>
      ${tile("Active today", m.active1d)}
      ${tile("Active 7d", m.active7d)}
      ${tile("Active 30d", m.active30d)}
    </tr></table>
    <table cellpadding="0" cellspacing="6" border="0" width="100%"><tr>
      ${tile("Total users", m.totalUsers)}
      ${tile("New 7d", `+${m.newUsers7d}`)}
      ${tile("Push devices", m.devices)}
    </tr></table>

    <div style="font-size:10px;color:${GOLD};letter-spacing:2px;text-transform:uppercase;margin:22px 0 8px">Where the app is actually alive (crowd reports, 7d)</div>
    <table cellpadding="0" cellspacing="0" border="0" width="100%">${cityRows}</table>

    <div style="font-size:10px;color:${GOLD};letter-spacing:2px;text-transform:uppercase;margin:22px 0 8px">Supply & revenue funnel</div>
    <table cellpadding="0" cellspacing="6" border="0" width="100%"><tr>
      ${tile("Venues", m.totalVenues)}
      ${tile("Claimed", m.claimedVenues, `${m.totalVenues ? Math.round((m.claimedVenues / m.totalVenues) * 100) : 0}%`)}
      ${tile("Live deals", m.activeDeals)}
    </tr></table>

    <p style="font-size:12px;color:${MUTED};margin-top:22px;line-height:1.6">Reality check: crowd reports this week: <strong style="color:${INK}">${m.crowd7d}</strong>. Active-7d ÷ total users (a rough stickiness read): <strong style="color:${INK}">${m.totalUsers ? Math.round((m.active7d / m.totalUsers) * 100) : 0}%</strong>. Density in your top city is what to grow — everything else is supply.</p>
  </div>`;
}

async function weeklyFounderDigest() {
  const to = process.env.FOUNDER_EMAIL || "dev@roaman.app";
  const m = await computeFounderMetrics();
  if (!process.env.RESEND_API_KEY) {
    console.log(`founder_digest (RESEND unset): users ${m.totalUsers} (+${m.newUsers7d}/7d), active7d ${m.active7d}, crowd7d ${m.crowd7d}, claimed ${m.claimedVenues}/${m.totalVenues}`);
    return 0;
  }
  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "Roaman <noreply@roaman.app>", to: [to], subject: `Roaman founder report — ${m.active7d} active this week, ${m.totalUsers} users`, html: renderFounderDigestHtml(m) }),
  });
  if (!resp.ok) throw new Error(`Resend ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return 1;
}

module.exports = { weeklyFounderDigest, computeFounderMetrics };
