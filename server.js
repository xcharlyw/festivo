require(‘dotenv’).config();
const express = require(‘express’);
const stripe = require(‘stripe’)(process.env.STRIPE_SECRET_KEY);
const cors = require(‘cors’);
const path = require(‘path’);

const app = express();

// ─── Config ───────────────────────────────────────────────────────────────────
const PLATFORM_FEE_PERCENT = 0.08; // 8% cut for Festivo
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(path.join(__dirname, ‘public’)));
app.use(’/webhook’, express.raw({ type: ‘application/json’ }));
app.use(express.json());

// ─── In-memory store (replace with real DB later) ─────────────────────────────
const organizers = {};
const orders = [];

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZER ROUTES
// ─────────────────────────────────────────────────────────────────────────────

app.post(’/api/organizer/onboard’, async (req, res) => {
try {
const { email, name } = req.body;
if (!email || !name) return res.status(400).json({ error: ‘email and name are required’ });

```
const account = await stripe.accounts.create({
  type: 'express',
  email,
  capabilities: {
    card_payments: { requested: true },
    transfers: { requested: true },
  },
  business_profile: { name, mcc: '7929' },
});

organizers[email] = { stripeAccountId: account.id, name, email, createdAt: new Date().toISOString() };

const accountLink = await stripe.accountLinks.create({
  account: account.id,
  refresh_url: `${process.env.BASE_URL}/organizer/onboard/refresh`,
  return_url:  `${process.env.BASE_URL}/organizer/onboard/complete`,
  type: 'account_onboarding',
});

res.json({ success: true, accountId: account.id, onboardingUrl: accountLink.url });
```

} catch (err) {
console.error(‘Onboard error:’, err.message);
res.status(500).json({ error: err.message });
}
});

app.get(’/api/organizer/dashboard/:accountId’, async (req, res) => {
try {
const loginLink = await stripe.accounts.createLoginLink(req.params.accountId);
res.json({ url: loginLink.url });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

app.get(’/api/admin/organizers’, (req, res) => {
res.json(Object.values(organizers));
});

// ─────────────────────────────────────────────────────────────────────────────
// CHECKOUT
// ─────────────────────────────────────────────────────────────────────────────

app.post(’/api/checkout’, async (req, res) => {
try {
const { eventName, ticketType, priceEuros, quantity, buyerEmail, organizerAccountId } = req.body;

```
if (!eventName || !priceEuros || !quantity || !organizerAccountId) {
  return res.status(400).json({ error: 'Missing required fields' });
}

const unitAmount   = Math.round(priceEuros * 100);
const totalAmount  = unitAmount * quantity;
const platformFee  = Math.round(totalAmount * PLATFORM_FEE_PERCENT);

const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  payment_method_types: ['card'],
  customer_email: buyerEmail || undefined,
  line_items: [{
    price_data: {
      currency: 'eur',
      product_data: {
        name: `${eventName} — ${ticketType}`,
        description: `Ticket for ${eventName}`,
      },
      unit_amount: unitAmount,
    },
    quantity,
  }],
  payment_intent_data: {
    application_fee_amount: platformFee,  // Festivo keeps this
    transfer_data: { destination: organizerAccountId }, // Rest to organizer
  },
  success_url: `${process.env.BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url:  `${process.env.BASE_URL}/cancel`,
  metadata: { eventName, ticketType, quantity: String(quantity), platformFee: String(platformFee), organizerAccountId },
});

res.json({ success: true, checkoutUrl: session.url, sessionId: session.id });
```

} catch (err) {
console.error(‘Checkout error:’, err.message);
res.status(500).json({ error: err.message });
}
});

app.get(’/api/order/:sessionId’, async (req, res) => {
try {
const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
res.json({ status: session.payment_status, customerEmail: session.customer_email, amountTotal: session.amount_total, metadata: session.metadata });
} catch (err) {
res.status(500).json({ error: err.message });
}
});

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK
// ─────────────────────────────────────────────────────────────────────────────

app.post(’/webhook’, (req, res) => {
const sig = req.headers[‘stripe-signature’];
let event;
try {
event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
} catch (err) {
return res.status(400).send(`Webhook Error: ${err.message}`);
}

if (event.type === ‘checkout.session.completed’) {
const s = event.data.object;
const order = {
id: s.id,
eventName: s.metadata.eventName,
ticketType: s.metadata.ticketType,
quantity: s.metadata.quantity,
amountTotal: s.amount_total,
platformFee: s.metadata.platformFee,
organizerPayout: s.amount_total - parseInt(s.metadata.platformFee),
buyerEmail: s.customer_email,
status: ‘paid’,
paidAt: new Date().toISOString(),
};
orders.push(order);
console.log(`✅ Sold: ${order.eventName} x${order.quantity} | Total: €${(order.amountTotal/100).toFixed(2)} | Your cut: €${(order.platformFee/100).toFixed(2)}`);
}

res.json({ received: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN
// ─────────────────────────────────────────────────────────────────────────────

app.get(’/api/admin/orders’, (req, res) => {
const totalRevenue = orders.reduce((sum, o) => sum + parseInt(o.platformFee || 0), 0);
res.json({ orders, totalOrders: orders.length, festivoRevenue: `€${(totalRevenue / 100).toFixed(2)}` });
});

// ─────────────────────────────────────────────────────────────────────────────
// PAGES
// ─────────────────────────────────────────────────────────────────────────────

const page = (emoji, title, msg) => `<!DOCTYPE html><html>

<head><title>Festivo</title>
<style>body{background:#0a0a0a;color:#f5f0e8;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;}h1{color:#e8521a;}a{color:#e8521a;}</style>
</head><body><div><div style="font-size:3.5rem">${emoji}</div><h1>${title}</h1><p style="color:#6b6660">${msg}</p><p style="margin-top:2rem"><a href="/">← Back to Festivo</a></p></div></body></html>`;

app.get(’/success’,                    (*, res) => res.send(page(‘🎉’, ‘ORDER CONFIRMED!’, ‘Your tickets are heading to your inbox.’)));
app.get(’/cancel’,                     (*, res) => res.send(page(‘😔’, ‘Payment Cancelled’, ‘No worries, try again anytime.’)));
app.get(’/organizer/onboard/complete’, (*, res) => res.send(page(‘✅’, “You’re all set!”, ‘Your organizer account is connected.’)));
app.get(’/organizer/onboard/refresh’,  (*, res) => res.redirect(’/’));

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
console.log(`\n🎟  FESTIVO running → http://localhost:${PORT}  (fee: 8%)\n`);
});
