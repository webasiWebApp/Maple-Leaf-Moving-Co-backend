import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { validate } from '../middleware/validate';
import { env } from '../config/env';
import { calculateQuote } from '../services/pricing';
import { supabase } from '../lib/supabaseAdmin';

export const checkoutRouter = Router();

// Initialise lazily so a missing key doesn't crash the process at import time.
let _stripe: Stripe | null = null;
const getStripe = (): Stripe => {
  if (!_stripe) {
    if (!env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
    _stripe = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return _stripe;
};

const instantCheckoutSchema = z.object({
  body: z.object({
    from: z.string().min(1).max(200),
    to: z.string().min(1).max(200),
    homeSize: z.enum(['studio', '1bed', '2bed', '3bed', 'office']),
    date: z.string().refine((d) => {
      const parsedDate = new Date(`${d}T12:00:00`);
      const minLeadTime = new Date();
      minLeadTime.setDate(minLeadTime.getDate() + 1); // 24 hours
      return !isNaN(parsedDate.getTime()) && parsedDate >= minLeadTime;
    }, 'Date must be at least 24 hours in the future'),
    consentTerms: z.boolean().refine(val => val === true, 'Terms must be accepted'),
    turnstileToken: z.string().min(1)
  }).strict()
});

checkoutRouter.post('/instant', validate(instantCheckoutSchema), async (req: Request, res: Response) => {
  try {
    const { from, to, homeSize, date, turnstileToken } = req.body;

    // Verify turnstile token (skip in dev when TURNSTILE_SECRET is not configured)
    if (env.TURNSTILE_SECRET) {
      const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `secret=${env.TURNSTILE_SECRET}&response=${turnstileToken}`
      });
      const turnstileResult = await turnstileRes.json();
      if (!turnstileResult.success) {
        return res.status(400).json({ error: { message: 'Bot verification failed' } });
      }
    }

    // TODO: Calculate distance via Google Maps (server-side)
    const distanceKm = 15; // Placeholder
    const driveMinutes = 20; // Placeholder

    // Hero Defaults
    const pricingInput = {
      homeSizeId: homeSize,
      items: {},
      addOns: [],
      stairsFrom: 'elevator',
      stairsTo: 'elevator',
      distanceKm,
      driveMinutes,
      moveDate: date,
      arrivalWindow: 'midday',
      flexibleDates: false
    };

    const pricingSnapshot = calculateQuote(pricingInput);

    // 1. Insert Quote (without user_id)
    const quoteRef = `MLM-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    const { data: quote, error: quoteError } = await supabase
      .from('quotes')
      .insert({
        reference: quoteRef,
        from_address: from,
        to_address: to,
        distance_km: distanceKm,
        duration_min: driveMinutes,
        home_size: homeSize,
        inventory: [],
        add_ons: [],
        stairs_from: 'elevator',
        stairs_to: 'elevator',
        move_date: date,
        flexible_dates: false,
        arrival_window: 'midday',
        estimated_hours: pricingSnapshot.hours,
        crew_size: pricingSnapshot.crew,
        price_low_cents: pricingSnapshot.totalCents,
        price_high_cents: pricingSnapshot.totalCents,
        deposit_cents: pricingSnapshot.totalCents,
        status: 'pending'
      })
      .select('id')
      .single();

    if (quoteError || !quote) {
      req.log.error(quoteError, 'Failed to insert quote');
      return res.status(500).json({ error: { message: 'Failed to create quote' } });
    }

    // 2. Insert Order
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        quote_id: quote.id,
        status: 'pending_payment',
        subtotal_cents: pricingSnapshot.subtotalCents,
        tax_cents: pricingSnapshot.taxCents,
        total_cents: pricingSnapshot.totalCents,
        currency: 'cad',
        move_date: date,
        pricing_snapshot: {
          input: pricingInput,
          breakdown: pricingSnapshot,
          engine_version: '1.0.0'
        },
        terms_version: '1.0.0',
        terms_accepted_at: new Date().toISOString()
      })
      .select('id')
      .single();

    if (orderError || !order) {
      req.log.error(orderError, 'Failed to insert order');
      return res.status(500).json({ error: { message: 'Failed to create order' } });
    }

    // 3. Create Stripe Checkout Session
    const session = await getStripe().checkout.sessions.create({
      ui_mode: 'hosted_page',
      mode: 'payment',
      currency: 'cad',
      billing_address_collection: 'auto',
      phone_number_collection: { enabled: true },
      automatic_tax: { enabled: false },
      allow_promotion_codes: false,
      submit_type: 'auto',
      client_reference_id: order.id,
      metadata: {
        order_id: order.id
      },
      // consent_collection: { terms_of_service: 'required' }, // Uncomment after setting Terms URL in Stripe Dashboard
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
      success_url: `${env.FRONTEND_URL}/checkout/success?order=${order.id}`,
      cancel_url: `${env.FRONTEND_URL}/checkout/cancelled`,
      line_items: [
        {
          price_data: {
            currency: 'cad',
            product_data: {
              name: 'Moving service (fixed price)',
            },
            unit_amount: pricingSnapshot.subtotalCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'cad',
            product_data: {
              name: 'HST (13%)',
            },
            unit_amount: pricingSnapshot.taxCents,
          },
          quantity: 1,
        }
      ],
    }, {
      idempotencyKey: `checkout_${order.id}`
    });

    // Update order with stripe_session_id
    await supabase
      .from('orders')
      .update({ stripe_session_id: session.id })
      .eq('id', order.id);

    res.json({ url: session.url });
  } catch (error) {
    req.log.error(error, 'Instant checkout error');
    res.status(500).json({ error: { message: 'Internal server error' } });
  }
});
