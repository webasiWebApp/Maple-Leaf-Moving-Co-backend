import { z } from 'zod';
import dotenv from 'dotenv';

// dotenv.config() silently does nothing when .env is absent — that is correct
// for Railway, which injects vars through its dashboard (process.env directly).
dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('8080'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  // Required vars use .default('') so startup is never blocked.
  // Missing values are caught below and logged by name (never by value).
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  SUPABASE_URL: z.string().default(''),
  SUPABASE_SERVICE_ROLE_KEY: z.string().default(''),
  GOOGLE_MAPS_API_KEY: z.string().default(''),
  RESEND_API_KEY: z.string().default(''),
  TURNSTILE_SECRET: z.string().default(''),
  FRONTEND_URL: z.string().default(''),
});

// These vars must be present for the app to work correctly.
// Startup continues without them so Railway's health-check can pass,
// but any route that needs a missing var will return a 500.
const REQUIRED_VARS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'GOOGLE_MAPS_API_KEY',
  'FRONTEND_URL',
] as const;

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Should never happen given all fields have defaults, but guard anyway.
  console.error('❌ Invalid environment variables:', parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

// Log missing required vars at startup — names only, never values.
const missing = REQUIRED_VARS.filter(key => !env[key]);
if (missing.length > 0) {
  console.warn('⚠️  Missing required environment variables (set these in Railway → Variables):');
  missing.forEach(key => console.warn(`   - ${key}`));
  console.warn('   Routes that depend on the above will fail until they are configured.');
}
