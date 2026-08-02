require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
// Config modules — throw at startup if required env vars are missing
require("./config/twilio");
const { supabase } = require("./config/supabase");
if (!process.env.ADMIN_SECRET) throw new Error("ADMIN_SECRET is not set");
const authRoutes      = require("./routes/auth");
const venueRoutes     = require("./routes/venues");
const storyRoutes     = require("./routes/stories");
const dealRoutes      = require("./routes/deals");
const eventRoutes     = require("./routes/events");
const friendRoutes    = require("./routes/friends");
const dashboardRoutes = require("./routes/dashboard");
const stripeRoutes    = require("./routes/stripe");
const webhookRoutes   = require("./routes/webhooks");
const adminAuth       = require("./middleware/adminAuth");
const adminRoutes     = require("./routes/admin");
const notificationRoutes = require("./routes/notifications");
const shareRoutes = require("./routes/share");
const analyticsRoutes = require("./routes/analytics");
require("./config/apns"); // logs a warning if push isn't configured yet
const refreshBusyScores = require("./jobs/refreshBusyScores");
const weeklyOwnerDigest = require("./jobs/weeklyOwnerDigest");
const marketingPushes = require("./jobs/marketingPushes");
const autoScrapeDeals = require("./jobs/autoScrapeDeals");
const { ensureMonthlyCrawl } = require("./jobs/monthlyCrawl");
const { weeklyFounderDigest } = require("./jobs/founderDigest");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use('/api/stripe/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
// cross-origin resource policy stays open so app.roaman.app can hotlink /photos redirects
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
const ALLOWED_ORIGINS = [
  "https://app.roaman.app",
  "https://roaman.app",
  "https://www.roaman.app",
  "capacitor://localhost", // iOS Capacitor webview
  "http://localhost:5173", // Vite dev
  "http://localhost:4173", // Vite preview
];
if (process.env.FRONTEND_URL) ALLOWED_ORIGINS.push(process.env.FRONTEND_URL);
// Requests without an Origin header (curl, server-to-server, native HTTP) pass through.
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED_ORIGINS.includes(origin)),
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
}));
app.use(express.json({ limit: "10mb" }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: "Too many requests, slow down." } });
app.use(limiter);

app.use("/api/auth",      authRoutes);
app.use("/api/venues",    venueRoutes);
app.use("/api/stories",   storyRoutes);
app.use("/api/deals",     dealRoutes);
app.use("/api/events",    eventRoutes);
app.use("/api/friends",   friendRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/stripe",    stripeRoutes);
app.use("/api/admin",     adminAuth, adminRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/share", shareRoutes);

app.get("/", (req, res) => res.json({ status: "Roam API is live 🌍", version: "1.0.0" }));
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong." });
});
app.listen(PORT, () => console.log(`Roam API running on port ${PORT}`));

// Startup catch-up: if this month's crawl hasn't happened yet, kick it off a
// minute after boot (so a redeploy right after the 1st still triggers it).
// The atomic claim makes this a no-op if the month is already done/running.
setTimeout(() => { ensureMonthlyCrawl().catch(err => console.error("monthly_crawl startup guard failed:", err)); }, 60000);

cron.schedule("*/15 * * * *", async () => {
  try {
    const count = await refreshBusyScores();
    console.log(`refresh_busy_scores: updated ${count} venues`);
  } catch (err) {
    console.error("refresh_busy_scores failed:", err);
  }
});

// Mondays 14:00 UTC — weekly founder metrics email (growth/active/retention).
cron.schedule("0 14 * * 1", async () => {
  try {
    const sent = await weeklyFounderDigest();
    console.log(`founder_digest: sent ${sent}`);
  } catch (err) {
    console.error("founder_digest failed:", err);
  }
});

// Mondays 13:00 UTC (~9am ET) — weekly analytics email to venue owners.
cron.schedule("0 13 * * 1", async () => {
  try {
    const sent = await weeklyOwnerDigest();
    console.log(`weekly_owner_digest: sent ${sent} emails`);
  } catch (err) {
    console.error("weekly_owner_digest failed:", err);
  }
});

// Daily 10:00 UTC — catch-up guard for the monthly deals+events crawl. The
// atomic month-claim in ensureMonthlyCrawl means the crawl runs exactly once
// per calendar month: on the 1st it's up, or the next day it self-heals if
// the 1st was missed. (Also called ~1 min after startup, below.)
cron.schedule("0 10 * * *", async () => {
  try { await ensureMonthlyCrawl(); }
  catch (err) { console.error("monthly_crawl guard failed:", err); }
});

// Daily 08:00 UTC — purge auth_events older than 90 days (bounded PII retention).
cron.schedule("0 8 * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const { error } = await supabase.from("auth_events").delete().lt("created_at", cutoff);
    if (error) throw error;
    console.log("auth_events_purge: removed events older than 90 days");
  } catch (err) {
    console.error("auth_events_purge failed:", err);
  }
});

// Daily 08:15 UTC — anonymize analytics_events older than 90 days: strip the
// user_id but KEEP the row, so long-term aggregate trends survive while no
// individual venue-visit/click history is retained past the analytics window
// (owner analytics only ever use 7–30 day windows).
cron.schedule("15 8 * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
    const { error, count } = await supabase.from("analytics_events")
      .update({ user_id: null }, { count: "exact" })
      .lt("created_at", cutoff).not("user_id", "is", null);
    if (error) throw error;
    console.log(`analytics_anonymize: cleared user_id on ${count ?? 0} events older than 90 days`);
  } catch (err) {
    console.error("analytics_anonymize failed:", err);
  }
});

// Sundays 09:00 UTC — auto-crawl deal coverage for venues added this week
// with a website and no deals (strict happy-hour-with-times pattern only).
cron.schedule("0 9 * * 0", async () => {
  try {
    const { crawled, inserted } = await autoScrapeDeals();
    console.log(`auto_scrape_deals: crawled ${crawled}, inserted ${inserted}`);
  } catch (err) {
    console.error("auto_scrape_deals failed:", err);
  }
});

// Hourly at :05 — scheduled marketing pushes; each entry fires only in the
// hour a city's local time matches its slot (opt-in users only).
cron.schedule("5 * * * *", async () => {
  try {
    const sent = await marketingPushes();
    if (sent) console.log(`marketing_pushes: sent ${sent}`);
  } catch (err) {
    console.error("marketing_pushes failed:", err);
  }
});
