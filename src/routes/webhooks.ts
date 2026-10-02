import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { env } from '../config/env';
import { supabase } from '../lib/supabaseAdmin';
import { sendCustomerConfirmation, sendOwnerAlert } from '../services/email';

export const stripeWebhookRouter = Router();

let _stripe: Stripe | null = null;
const getStripe = (): Stripe => {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' as any });
  }
  return _stripe;
};

stripeWebhookRouter.post('/', async (req: Request, res: Response) => {
  const sig = req.headers['stripe-signature'];

  let event: Stripe.Event;

  try {
    if (!sig) throw new Error('No signature');
    // req.body is already raw buffer because we used express.raw in app.ts
    event = getStripe().webhooks.constructEvent(req.body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    req.log.error(`Webhook Error: ${err.message}`);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    // Idempotency: insert event, if it fails because it already exists, ignore
    const { error: eventError } = await supabase
      .from('stripe_events')
      .insert({ event_id: event.id, type: event.type });
    
    if (eventError && eventError.code === '23505') { // Unique violation
      req.log.info(`Skipping duplicate webhook event ${event.id}`);
      res.json({ received: true });
      return;
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        req.log.info({ sessionId: session.id }, 'Checkout session completed');

        if (session.payment_status === 'paid') {
          const orderId = session.metadata?.order_id;
          if (!orderId) throw new Error('No order_id in session metadata');

          // Verify order exists and amounts match
          const { data: order } = await supabase
            .from('orders')
            .select('*, quote:quotes(from_address, to_address)')
            .eq('id', orderId)
            .single();

          if (!order) throw new Error(`Order ${orderId} not found`);
          if (order.status === 'paid') {
            req.log.info(`Order ${orderId} is already paid`);
            break;
          }
          
          if (session.amount_total !== order.total_cents || session.currency !== 'cad') {
            req.log.error(`Amount mismatch for order ${orderId}`);
            // Optionally alert owner here
            break;
          }

          // Mark order as paid
          const customerName = session.customer_details?.name || 'Guest';
          const customerEmail = session.customer_details?.email || '';
          const customerPhone = session.customer_details?.phone || '';

          await supabase
            .from('orders')
            .update({
              status: 'paid',
              stripe_payment_intent_id: session.payment_intent as string,
              customer_name: customerName,
              customer_email: customerEmail,
              customer_phone: customerPhone,
              paid_at: new Date().toISOString()
            })
            .eq('id', orderId);

          // Insert order event
          await supabase
            .from('order_events')
            .insert({
              order_id: orderId,
              event_type: 'paid',
              detail: `Paid via Stripe session ${session.id}`
            });

          // Send emails
          await sendCustomerConfirmation(orderId, customerEmail, customerName, order.move_date, order.total_cents);
          await sendOwnerAlert(orderId, customerName, customerEmail, customerPhone, order.move_date, order.total_cents, order.quote?.from_address || '', order.quote?.to_address || '');

          await supabase
            .from('order_events')
            .insert({
              order_id: orderId,
              event_type: 'email_sent',
              detail: 'Confirmation emails sent to customer and owner'
            });
        }
        break;
      }
      // ... handle other event types like refund
      case 'charge.refunded': {
        // Handle refund logic if needed
        break;
      }
      default:
        req.log.info(`Unhandled event type ${event.type}`);
    }

    // Mark event processed
    await supabase
      .from('stripe_events')
      .update({ processed_at: new Date().toISOString() })
      .eq('event_id', event.id);

    res.json({ received: true });
  } catch (error) {
    req.log.error(error, 'Error processing webhook');
    res.status(500).send('Internal Server Error processing webhook');
  }
});
