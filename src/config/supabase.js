// src/config/supabase.js
// ─────────────────────────────────────────────────────────────
// Backend Supabase client — uses the SERVICE ROLE key.
// This bypasses RLS so webhooks can write subscription state.
// NEVER expose this key to the frontend.
// ─────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

const supabaseUrl     = process.env.SUPABASE_URL;
const supabaseService = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseService) {
  throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set');
}

const supabase = createClient(supabaseUrl, supabaseService, {
  auth: {
    autoRefreshToken: false,
    persistSession:   false,
  },
});

export default supabase;


// ── Subscription helpers ──────────────────────────────────────

/**
 * Upsert a subscription row and sync venues.tier in one transaction.
 * Called by every webhook handler — single source of truth for state.
 */
export async function syncSubscription({
  venueId,
  ownerId,
  stripeCustomerId,
  stripeSubId,
  stripePriceId,
  tier,
  status,
  cancelAtPeriodEnd,
  currentPeriodStart,
  currentPeriodEnd,
}) {
  // 1. Upsert the subscription record
  const { error: subError } = await supabase
    .from('subscriptions')
    .upsert(
      {
        venue_id:              venueId,
        owner_id:              ownerId,
        stripe_customer_id:    stripeCustomerId,
        stripe_sub_id:         stripeSubId,
        stripe_price_id:       stripePriceId,
        tier,
        status,
        cancel_at_period_end:  cancelAtPeriodEnd,
        current_period_start:  currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
        current_period_end:    currentPeriodEnd   ? new Date(currentPeriodEnd   * 1000).toISOString() : null,
      },
      { onConflict: 'venue_id' }
    );

  if (subError) throw subError;

  // 2. Sync tier + heatmap_boost to venues table
  const { error: venueError } = await supabase
    .from('venues')
    .update({
      tier,
      stripe_customer_id: stripeCustomerId,
      heatmap_boost:      tier === 'premium',
    })
    .eq('id', venueId);

  if (venueError) throw venueError;
}

/**
 * Downgrade a venue to free tier when subscription is cancelled.
 * Looks up venue_id from stripe_customer_id (available in deletion events).
 */
export async function downgradeToFree(stripeCustomerId) {
  // Find the subscription by Stripe customer ID
  const { data: sub, error: findError } = await supabase
    .from('subscriptions')
    .select('venue_id, owner_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (findError || !sub) {
    console.error('downgradeToFree: subscription not found for customer', stripeCustomerId);
    return;
  }

  await syncSubscription({
    venueId:          sub.venue_id,
    ownerId:          sub.owner_id,
    stripeCustomerId,
    stripeSubId:      null,
    stripePriceId:    null,
    tier:             'free',
    status:           'canceled',
    cancelAtPeriodEnd: false,
    currentPeriodStart: null,
    currentPeriodEnd:   null,
  });
}
