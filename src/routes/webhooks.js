const express = require('express');
const { stripe } = require('../config/stripe');
const { syncSubscription, downgradeToFree } = require('../config/supabase');

const router = express.Router();

router.post('/', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('Webhook received:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        if (session.mode !== 'subscription') break;

        const sub = await stripe.subscriptions.retrieve(session.subscription);
        const priceId = sub.items.data[0].price.id;
        const tier = priceId === process.env.STRIPE_PRICE_PREMIUM ? 'premium' : 'pro';

        await syncSubscription({
          venueId:            session.metadata.venue_id,
          ownerId:            session.metadata.owner_id,
          stripeCustomerId:   session.customer,
          stripeSubId:        sub.id,
          stripePriceId:      priceId,
          tier,
          status:             'active',
          cancelAtPeriodEnd:  false,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd:   sub.current_period_end,
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;

        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const priceId = sub.items.data[0].price.id;
        const tier = priceId === process.env.STRIPE_PRICE_PREMIUM ? 'premium' : 'pro';

        await syncSubscription({
          venueId:            sub.metadata.venue_id,
          ownerId:            sub.metadata.owner_id,
          stripeCustomerId:   invoice.customer,
          stripeSubId:        sub.id,
          stripePriceId:      priceId,
          tier,
          status:             'active',
          cancelAtPeriodEnd:  sub.cancel_at_period_end,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd:   sub.current_period_end,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (!invoice.subscription) break;

        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        const priceId = sub.items.data[0].price.id;
        const tier = priceId === process.env.STRIPE_PRICE_PREMIUM ? 'premium' : 'pro';

        await syncSubscription({
          venueId:            sub.metadata.venue_id,
          ownerId:            sub.metadata.owner_id,
          stripeCustomerId:   invoice.customer,
          stripeSubId:        sub.id,
          stripePriceId:      priceId,
          tier,
          status:             'past_due',
          cancelAtPeriodEnd:  sub.cancel_at_period_end,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd:   sub.current_period_end,
        });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items.data[0].price.id;
        const tier = priceId === process.env.STRIPE_PRICE_PREMIUM ? 'premium' : 'pro';

        await syncSubscription({
          venueId:            sub.metadata.venue_id,
          ownerId:            sub.metadata.owner_id,
          stripeCustomerId:   sub.customer,
          stripeSubId:        sub.id,
          stripePriceId:      priceId,
          tier,
          status:             sub.status,
          cancelAtPeriodEnd:  sub.cancel_at_period_end,
          currentPeriodStart: sub.current_period_start,
          currentPeriodEnd:   sub.current_period_end,
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        await downgradeToFree(sub.customer);
        break;
      }

      default:
        console.log('Unhandled event type:', event.type);
    }

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
