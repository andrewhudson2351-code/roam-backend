// src/routes/stripe.js
// ─────────────────────────────────────────────────────────────
// Phase 2 Stripe routes:
//   POST /api/stripe/create-customer
//   POST /api/stripe/create-checkout-session
//   GET  /api/stripe/subscription-status/:venueId
//
// Mount in your main app.js:
//   import stripeRoutes from './routes/stripe.js';
//   app.use('/api/stripe', stripeRoutes);
// ─────────────────────────────────────────────────────────────

import express from 'express';
import stripe, { PRICE_IDS } from '../config/stripe.js';
import supabase from '../config/supabase.js';

const router = express.Router();


// ── Auth middleware ───────────────────────────────────────────
// Validates the Supabase JWT from the Authorization header.
// Attaches req.user = { id, email } on success.
// Replace this with your existing auth middleware if you have one.

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// ── Venue ownership guard ─────────────────────────────────────
// Ensures the authenticated user owns the venue they're acting on.
// Returns the venue row on success.

async function getOwnedVenue(userId, venueId) {
  const { data: venue, error } = await supabase
    .from('venues')
    .select('id, name, tier, stripe_customer_id, owner_id')
    .eq('id', venueId)
    .eq('owner_id', userId)   // ownership check
    .single();

  if (error || !venue) return null;
  return venue;
}


// ─────────────────────────────────────────────────────────────
// POST /api/stripe/create-customer
//
// Creates a Stripe Customer for a venue if one doesn't exist.
// Safe to call multiple times — idempotent.
//
// Body: { venueId }
// Response: { customerId }
// ─────────────────────────────────────────────────────────────

router.post('/create-customer', requireAuth, async (req, res) => {
  const { venueId } = req.body;

  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required' });
  }

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) {
      return res.status(404).json({ error: 'Venue not found or not owned by you' });
    }

    // Already has a Stripe customer — return it (idempotent)
    if (venue.stripe_customer_id) {
      return res.json({ customerId: venue.stripe_customer_id });
    }

    // Create a new Stripe customer
    const customer = await stripe.customers.create({
      email: req.user.email,
      name:  venue.name,
      metadata: {
        venue_id:  venueId,
        owner_id:  req.user.id,
        env:       process.env.NODE_ENV,
      },
    });

    // Persist to Supabase
    const { error: updateError } = await supabase
      .from('venues')
      .update({ stripe_customer_id: customer.id })
      .eq('id', venueId);

    if (updateError) throw updateError;

    // Also create a minimal subscriptions row (free tier baseline)
    await supabase
      .from('subscriptions')
      .upsert(
        {
          venue_id:           venueId,
          owner_id:           req.user.id,
          stripe_customer_id: customer.id,
          tier:               'free',
          status:             'inactive',
        },
        { onConflict: 'venue_id' }
      );

    res.json({ customerId: customer.id });

  } catch (err) {
    console.error('create-customer error:', err);
    res.status(500).json({ error: 'Failed to create customer' });
  }
});


// ─────────────────────────────────────────────────────────────
// POST /api/stripe/create-checkout-session
//
// Creates a Stripe Hosted Checkout session for Pro or Premium.
// The frontend redirects the user to session.url.
//
// Body: { venueId, tier }  — tier must be 'pro' | 'premium'
// Response: { url }  — redirect the user here
// ─────────────────────────────────────────────────────────────

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { venueId, tier } = req.body;

  if (!venueId || !tier) {
    return res.status(400).json({ error: 'venueId and tier are required' });
  }

  const priceId = PRICE_IDS[tier];
  if (!priceId) {
    return res.status(400).json({ error: `Invalid tier: ${tier}. Must be 'pro' or 'premium'` });
  }

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) {
      return res.status(404).json({ error: 'Venue not found or not owned by you' });
    }

    // Ensure Stripe customer exists — create inline if missing
    let customerId = venue.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: req.user.email,
        name:  venue.name,
        metadata: { venue_id: venueId, owner_id: req.user.id },
      });
      customerId = customer.id;

      await supabase
        .from('venues')
        .update({ stripe_customer_id: customerId })
        .eq('id', venueId);
    }

    // Create the Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        'subscription',
      line_items: [
        {
          price:    priceId,
          quantity: 1,
        },
      ],

      // These URLs are where Stripe redirects after checkout
      success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}&venue_id=${venueId}`,
      cancel_url:  `${process.env.STRIPE_CANCEL_URL}?venue_id=${venueId}`,

      // Pre-fill the customer's email in the Stripe form
      customer_email: venue.stripe_customer_id ? undefined : req.user.email,

      // Allow promotion codes (optional — add later when you have coupons)
      // allow_promotion_codes: true,

      // Metadata for webhook reconciliation
      metadata: {
        venue_id: venueId,
        owner_id: req.user.id,
        tier,
      },

      // Subscription metadata (accessible in webhook sub.metadata)
      subscription_data: {
        metadata: {
          venue_id: venueId,
          owner_id: req.user.id,
          tier,
        },
      },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});


// ─────────────────────────────────────────────────────────────
// GET /api/stripe/subscription-status/:venueId
//
// Returns the current subscription state for the billing dashboard.
// Used by the frontend to show current plan, renewal date, etc.
//
// Response: { tier, status, currentPeriodEnd, cancelAtPeriodEnd, stripeSubId }
// ─────────────────────────────────────────────────────────────

router.get('/subscription-status/:venueId', requireAuth, async (req, res) => {
  const { venueId } = req.params;

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) {
      return res.status(404).json({ error: 'Venue not found or not owned by you' });
    }

    // Pull from the view we created in the migration
    const { data: sub, error } = await supabase
      .from('venue_subscription_status')
      .select('*')
      .eq('venue_id', venueId)
      .single();

    if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows, that's fine

    // Default response for venues with no subscription row yet
    const result = {
      tier:              sub?.current_tier         ?? 'free',
      status:            sub?.subscription_status  ?? 'inactive',
      currentPeriodEnd:  sub?.current_period_end   ?? null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      stripeSubId:       sub?.stripe_sub_id        ?? null,
      heatmapBoost:      sub?.heatmap_boost        ?? false,
    };

    res.json(result);

  } catch (err) {
    console.error('subscription-status error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});


export default router;
