const { createClient } = require('@supabase/supabase-js');

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

async function syncSubscription({
  venueId, ownerId, stripeCustomerId, stripeSubId,
  stripePriceId, tier, status, cancelAtPeriodEnd,
  currentPeriodStart, currentPeriodEnd,
}) {
  const { error: subError } = await supabase
    .from('subscriptions')
    .upsert(
      {
        venue_id:             venueId,
        owner_id:             ownerId,
        stripe_customer_id:   stripeCustomerId,
        stripe_sub_id:        stripeSubId,
        stripe_price_id:      stripePriceId,
        tier,
        status,
        cancel_at_period_end: cancelAtPeriodEnd,
        current_period_start: currentPeriodStart ? new Date(currentPeriodStart * 1000).toISOString() : null,
        current_period_end:   currentPeriodEnd   ? new Date(currentPeriodEnd   * 1000).toISOString() : null,
      },
      { onConflict: 'venue_id' }
    );

  if (subError) throw subError;

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

async function downgradeToFree(stripeCustomerId) {
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
    venueId:            sub.venue_id,
    ownerId:            sub.owner_id,
    stripeCustomerId,
    stripeSubId:        null,
    stripePriceId:      null,
    tier:               'free',
    status:             'canceled',
    cancelAtPeriodEnd:  false,
    currentPeriodStart: null,
    currentPeriodEnd:   null,
  });
}

module.exports = { supabase, syncSubscription, downgradeToFree };
