require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cron = require("node-cron");
// Config modules — throw at startup if required env vars are missing
require("./config/twilio");
if (!process.env.ADMIN_SECRET) throw new Error("ADMIN_SECRET is not set");
const authRoutes      = require("./routes/auth");
const venueRoutes     = require("./routes/venues");
const storyRoutes     = require("./routes/stories");
const dealRoutes      = require("./routes/deals");
const friendRoutes    = require("./routes/friends");
const dashboardRoutes = require("./routes/dashboard");
const stripeRoutes    = require("./routes/stripe");
const webhookRoutes   = require("./routes/webhooks");
const adminAuth       = require("./middleware/adminAuth");
const adminRoutes     = require("./routes/admin");
const refreshBusyScores = require("./jobs/refreshBusyScores");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use('/api/stripe/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] }));
app.use(express.json({ limit: "10mb" }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: "Too many requests, slow down." } });
app.use(limiter);

app.use("/api/auth",      authRoutes);
app.use("/api/venues",    venueRoutes);
app.use("/api/stories",   storyRoutes);
app.use("/api/deals",     dealRoutes);
app.use("/api/friends",   friendRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/stripe",    stripeRoutes);
app.use("/api/admin",     adminAuth, adminRoutes);

app.get("/", (req, res) => res.json({ status: "Roam API is live 🌍", version: "1.0.0" }));
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong." });
});
app.listen(PORT, () => console.log(`Roam API running on port ${PORT}`));

cron.schedule("*/15 * * * *", async () => {
  try {
    const count = await refreshBusyScores();
    console.log(`refresh_busy_scores: updated ${count} venues`);
  } catch (err) {
    console.error("refresh_busy_scores failed:", err);
  }
});
