// CR AudioViz AI - Stripe Webhook Handler
// UPDATED: 2025-12-02 - New subscription plans and credit packs
// Processes payment events and manages credits automatically

import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { secretKey } from "@craudioviz/platform-sdk";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16',
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  secretKey()
);

// ============================================================================
// PRODUCT TO CREDITS MAPPING - UPDATED 2025-12-02
// ============================================================================
const PRODUCT_CREDITS = {
  // NEW CR AudioViz Subscription Plans
  'prod_TX1iwTUdlTE1Ku': { credits: 100, plan: 'starter', type: 'subscription' },
  'prod_TX1ixXF1tiYr7F': { credits: 500, plan: 'pro', type: 'subscription' },
  'prod_TX1irxT9gWLZI4': { credits: 2000, plan: 'business', type: 'subscription' },
  'prod_TX1jTG2blyNVvG': { credits: 99999, plan: 'enterprise', type: 'subscription' },
  
  // NEW Credit Packs (one-time)
  'prod_TX1jJUntv6mbS5': { credits: 10, plan: null, type: 'credits' },
  'prod_TX1jCgo0pVlNUk': { credits: 50, plan: null, type: 'credits' },
  'prod_TX1j5bYMlCDkwn': { credits: 200, plan: null, type: 'credits' },
  
  // LEGACY Products
  'prod_TI6896ICKs0DEL': { credits: 100, plan: 'basic', type: 'subscription' },
  'prod_TI63IMdxRSMGKt': { credits: 100, plan: null, type: 'credits' },
  'prod_TI6861Obu8vfg7': { credits: 500, plan: null, type: 'credits' },
};

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function getOrCreateUser(stripeCustomerId, email, name) {
  let { data: existingUser } = await supabase
    .from('customers')
    .select('*, user_id')
    .eq('stripe_customer_id', stripeCustomerId)
    .single();

  if (existingUser) return existingUser;

  const { data: newCustomer, error } = await supabase
    .from('customers')
    .insert({ stripe_customer_id: stripeCustomerId, email, name })
    .select()
    .single();

  if (error) throw error;
  return newCustomer;
}

async function addCreditsToUser(userId, credits, description, paymentId) {
  const { data: current } = await supabase
    .from('user_credits')
    .select('balance')
    .eq('user_id', userId)
    .single();

  const newBalance = (current?.balance || 0) + credits;

  await supabase
    .from('user_credits')
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq('user_id', userId);

  await supabase.from('credit_transactions').insert({
    user_id: userId,
    amount: credits,
    description,
    balance_after: newBalance,
    build_id: paymentId,
  });

  console.log(`Added ${credits} credits to user ${userId}. Balance: ${newBalance}`);
  return newBalance;
}

async function updateUserPlan(userId, plan, monthlyCredits) {
  await supabase
    .from('user_credits')
    .update({ plan, plan_credits_monthly: monthlyCredits, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

async function handleCheckoutSessionCompleted(session) {
  console.log('Processing checkout.session.completed:', session.id);

  const stripeCustomer = await stripe.customers.retrieve(session.customer);
  const customer = await getOrCreateUser(session.customer, stripeCustomer.email, stripeCustomer.name);

  const lineItems = await stripe.checkout.sessions.listLineItems(session.id);

  for (const item of lineItems.data) {
    const price = await stripe.prices.retrieve(item.price.id);
    const productId = price.product;
    const config = PRODUCT_CREDITS[productId];

    if (!config) {
      console.log(`Unknown product: ${productId}`);
      continue;
    }

    const { credits, plan, type } = config;

    if (customer.user_id) {
      await addCreditsToUser(
        customer.user_id,
        credits,
        type === 'subscription' ? `${plan.toUpperCase()} subscription: ${credits} credits` : `Purchased ${credits} credits`,
        session.payment_intent
      );

      if (type === 'subscription' && plan) {
        await updateUserPlan(customer.user_id, plan, credits);
      }
    } else {
      await supabase
        .from('customers')
        .update({ pending_credits: (customer.pending_credits || 0) + credits, pending_plan: plan })
        .eq('id', customer.id);
      console.log(`Stored ${credits} pending credits for ${stripeCustomer.email}`);
    }

    if (type === 'subscription' && session.subscription) {
      await supabase.from('subscriptions').upsert({
        customer_id: customer.id,
        user_id: customer.user_id,
        stripe_subscription_id: session.subscription,
        stripe_product_id: productId,
        plan,
        status: 'active',
        credits_monthly: credits,
        current_period_start: new Date().toISOString(),
      }, { onConflict: 'stripe_subscription_id' });
    }
  }
}

async function handleInvoicePaymentSucceeded(invoice) {
  console.log('Processing invoice.payment_succeeded:', invoice.id);
  if (!invoice.subscription) return;

  const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
  const productId = subscription.items.data[0].price.product;
  const config = PRODUCT_CREDITS[productId];
  if (!config) return;

  const { data: customer } = await supabase
    .from('customers')
    .select('*, user_id')
    .eq('stripe_customer_id', invoice.customer)
    .single();

  if (customer?.user_id) {
    await addCreditsToUser(
      customer.user_id,
      config.credits,
      `${config.plan.toUpperCase()} renewal: ${config.credits} credits`,
      invoice.payment_intent
    );
  }
}

async function handleSubscriptionUpdated(subscription) {
  console.log('Processing subscription.updated:', subscription.id);
  const productId = subscription.items.data[0].price.product;
  const config = PRODUCT_CREDITS[productId];

  await supabase
    .from('subscriptions')
    .update({
      status: subscription.status,
      plan: config?.plan || 'unknown',
      credits_monthly: config?.credits || 0,
      current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
      cancel_at_period_end: subscription.cancel_at_period_end,
      updated_at: new Date().toISOString(),
    })
    .eq('stripe_subscription_id', subscription.id);
}

async function handleSubscriptionDeleted(subscription) {
  console.log('Processing subscription.deleted:', subscription.id);

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscription.id)
    .single();

  await supabase.from('subscriptions')
    .update({ status: 'canceled', updated_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id);

  if (sub?.user_id) {
    await supabase.from('user_credits')
      .update({ plan: 'free', plan_credits_monthly: 0 })
      .eq('user_id', sub.user_id);
  }
}

async function logWebhookEvent(eventId, eventType, processed, error, payload) {
  await supabase.from('webhook_events').insert({
    stripe_event_id: eventId,
    event_type: eventType,
    processed,
    error_message: error,
    payload,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  console.log('Received:', event.type);

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handleInvoicePaymentSucceeded(event.data.object);
        break;
      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      default:
        console.log(`Unhandled: ${event.type}`);
    }

    await logWebhookEvent(event.id, event.type, true, null, event.data.object);
    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    await logWebhookEvent(event.id, event.type, false, error.message, event.data.object);
    res.status(500).json({ error: error.message });
  }
}
