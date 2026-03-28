const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const supabase = require("../supabase");
const authMiddleware = require("../middleware/auth");

const PRO_PRICE_ID     = process.env.STRIPE_PRO_PRICE_ID;
const PREMIUM_PRICE_ID = process.env.STRIPE_PREMIUM_PRICE_ID;
const FRONTEND_URL     = process.env.FRONTEND_URL || "https://roam-frontend-rho.vercel.app";

// ── POST /api/billing/create-checkout ─────────────────
// Creates a Stripe Checkout session for a venue subscription
router.post("/create-checkout", authMiddleware, async (req, res) => {
  try {
    const { venue_id, plan } = req.body;
    if (!venue_id || !plan) return res.status(400).json({ error: "venue_id and plan required." });
    if (!["pro", "premium"].includes(plan)) return res.status(400).json({ error: "Invalid plan." });

    // Verify venue ownership
    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, name, owner_id, stripe_customer_id")
      .eq("id", venue_id)
      .single();

    if (venueError || !venue) return res.status(404).json({ error: "Venue not found." });
    if (venue.owner_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });

    const priceId = plan === "pro" ? PRO_PRICE_ID : PREMIUM_PRICE_ID;

    // Create or reuse Stripe customer
    let customerId = venue.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        metadata: { venue_id, user_id: req.user.id },
      });
      customerId = customer.id;
      await supabase.from("venues").update({ stripe_customer_id: customerId }).eq("id", venue_id);
    }

    // Create checkout session
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel`,
      metadata: { venue_id, plan, user_id: req.user.id },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

// ── GET /api/billing/portal ────────────────────────────
// Creates a Stripe Billing Portal session for managing subscriptions
router.get("/portal", authMiddleware, async (req, res) => {
  try {
    const { venue_id } = req.query;
    if (!venue_id) return res.status(400).json({ error: "venue_id required." });

    const { data: venue } = await supabase
      .from("venues")
      .select("id, owner_id, stripe_customer_id")
      .eq("id", venue_id)
      .single();

    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    if (!venue.stripe_customer_id) return res.status(400).json({ error: "No billing account found." });

    const session = await stripe.billingPortal.sessions.create({
      customer: venue.stripe_customer_id,
      return_url: `${FRONTEND_URL}`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: "Failed to create billing portal session." });
  }
});

// ── POST /api/billing/webhook ──────────────────────────
// Handles Stripe webhook events
// Must be registered BEFORE express.json() middleware in index.js
// Use raw body: app.post("/api/billing/webhook", express.raw({type: "application/json"}), ...)
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const { venue_id, plan } = session.metadata;
        if (venue_id && plan) {
          await supabase.from("venues").update({ plan }).eq("id", venue_id);
          console.log(`✅ Plan updated: venue ${venue_id} → ${plan}`);
        }
        break;
      }
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const venue_id = customer.metadata?.venue_id;
        if (venue_id) {
          const plan = sub.status === "active" ? (
            sub.items.data[0].price.id === PRO_PRICE_ID ? "pro" : "premium"
          ) : "free";
          await supabase.from("venues").update({ plan }).eq("id", venue_id);
          console.log(`✅ Subscription updated: venue ${venue_id} → ${plan}`);
        }
        break;
      }
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const customer = await stripe.customers.retrieve(sub.customer);
        const venue_id = customer.metadata?.venue_id;
        if (venue_id) {
          await supabase.from("venues").update({ plan: "free" }).eq("id", venue_id);
          console.log(`✅ Subscription cancelled: venue ${venue_id} → free`);
        }
        break;
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook processing error:", err);
    res.status(500).json({ error: "Webhook processing failed." });
  }
});

// ── GET /api/billing/status ────────────────────────────
// Returns current plan for a venue
router.get("/status", authMiddleware, async (req, res) => {
  try {
    const { venue_id } = req.query;
    const { data: venue } = await supabase
      .from("venues")
      .select("id, plan, owner_id")
      .eq("id", venue_id)
      .single();

    if (!venue || venue.owner_id !== req.user.id) return res.status(403).json({ error: "Not authorized." });
    res.json({ plan: venue.plan || "free" });
  } catch (err) {
    res.status(500).json({ error: "Failed to get billing status." });
  }
});

module.exports = router;
