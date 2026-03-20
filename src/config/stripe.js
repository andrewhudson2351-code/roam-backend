const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('STRIPE_SECRET_KEY is not set in environment variables');
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  throw new Error('STRIPE_WEBHOOK_SECRET is not set in environment variables');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-06-20',
  maxNetworkRetries: 2,
});

const PRICE_IDS = {
  pro:     process.env.STRIPE_PRICE_PRO,
  premium: process.env.STRIPE_PRICE_PREMIUM,
};

function getTierFromPriceId(priceId) {
  const map = Object.fromEntries(
    Object.entries(PRICE_IDS).map(([tier, id]) => [id, tier])
  );
  return map[priceId] ?? 'free';
}

module.exports = { stripe, PRICE_IDS, getTierFromPriceId };
