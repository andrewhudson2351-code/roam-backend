require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const authRoutes      = require("./routes/auth");
const venueRoutes     = require("./routes/venues");
const storyRoutes     = require("./routes/stories");
const dealRoutes      = require("./routes/deals");
const friendRoutes    = require("./routes/friends");
const dashboardRoutes = require("./routes/dashboard");
const stripeRoutes    = require("./routes/stripe");
const webhookRoutes   = require("./routes/webhooks");
const billingRoutes   = require("./routes/billing");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use('/api/stripe/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(cors({ origin: "*", methods: ["GET", "POST", "PUT", "DELETE", "PATCH"] }));
app.use(express.json({ limit: "10mb" }));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: "Too many requests, slow down." });
app.use(limiter);

app.use("/api/auth",      authRoutes);
app.use("/api/venues",    venueRoutes);
app.use("/api/stories",   storyRoutes);
app.use("/api/deals",     dealRoutes);
app.use("/api/friends",   friendRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/stripe",    stripeRoutes);
app.use("/api/billing",   billingRoutes);

app.get("/", (req, res) => res.json({ status: "Roam API is live 🌍", version: "1.0.0" }));
app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong." });
});
app.listen(PORT, () => console.log(`🌍 Roam API running on port ${PORT}`));
