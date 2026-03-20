const express               = require('express');
const { stripe, PRICE_IDS } = require('../config/stripe');
const { supabase }          = require('../config/supabase');

const router = express.Router();

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

async function getOwnedVenue(userId, venueId) {
  const { data: venue, error } = await supabase
    .from('venues')
    .select('id, name, tier, stripe_customer_id, owner_id')
    .eq('id', venueId)
    .eq('owner_id', userId)
    .single();

  if (error || !venue) return null;
  return venue;
}

router.post('/create-customer', requireAuth, async (req, res) => {
  const { venueId } = req.body;
  if (!venueId) return res.status(400).json({ error: 'venueId is required' });

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) return res.status(404).json({ error: 'Venue not found or not owned by you' });

    if (venue.stripe_customer_id) {
      return res.json({ customerId: venue.stripe_customer_id });
    }

    const customer = await stripe.customers.create({
      email:    req.user.email,
      name:     venue.name,
      metadata: { venue_id: venueId, owner_id: req.user.id },
    });

    const { error: updateError } = await supabase
      .from('venues')
      .update({ stripe_customer_id: customer.id })
      .eq('id', venueId);

    if (updateError) throw updateError;

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

router.post('/create-checkout-session', requireAuth, async (req, res) => {
  const { venueId, tier } = req.body;
  if (!venueId || !tier) return res.status(400).json({ error: 'venueId and tier are required' });

  const priceId = PRICE_IDS[tier];
  if (!priceId) return res.status(400).json({ error: `Invalid tier: ${tier}` });

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) return res.status(404).json({ error: 'Venue not found or not owned by you' });

    let customerId = venue.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    req.user.email,
        name:     venue.name,
        metadata: { venue_id: venueId, owner_id: req.user.id },
      });
      customerId = customer.id;
      await supabase
        .from('venues')
        .update({ stripe_customer_id: customerId })
        .eq('id', venueId);
    }

    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.STRIPE_SUCCESS_URL}?session_id={CHECKOUT_SESSION_ID}&venue_id=${venueId}`,
      cancel_url:  `${process.env.STRIPE_CANCEL_URL}?venue_id=${venueId}`,
      metadata:         { venue_id: venueId, owner_id: req.user.id, tier },
      subscription_data: { metadata: { venue_id: venueId, owner_id: req.user.id, tier } },
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('create-checkout-session error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.get('/subscription-status/:venueId', requireAuth, async (req, res) => {
  const { venueId } = req.params;

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) return res.status(404).json({ error: 'Venue not found or not owned by you' });

    const { data: sub, error } = await supabase
      .from('venue_subscription_status')
      .select('*')
      .eq('venue_id', venueId)
      .single();

    if (error && error.code !== 'PGRST116') throw error;

    res.json({
      tier:              sub?.current_tier         ?? 'free',
      status:            sub?.subscription_status  ?? 'inactive',
      currentPeriodEnd:  sub?.current_period_end   ?? null,
      cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false,
      stripeSubId:       sub?.stripe_sub_id        ?? null,
      heatmapBoost:      sub?.heatmap_boost        ?? false,
    });

  } catch (err) {
    console.error('subscription-status error:', err);
    res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});
router.post('/create-portal-session', requireAuth, async (req, res) => {
  const { venueId } = req.body;

  if (!venueId) {
    return res.status(400).json({ error: 'venueId is required' });
  }

  try {
    const venue = await getOwnedVenue(req.user.id, venueId);
    if (!venue) {
      return res.status(404).json({ error: 'Venue not found or not owned by you' });
    }

    if (!venue.stripe_customer_id) {
      return res.status(400).json({ error: 'No billing account found for this venue' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   venue.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('create-portal-session error:', err);
    res.status(500).json({ error: 'Failed to create portal session' });
  }
});

module.exports = router;
