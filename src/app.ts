import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import hpp from 'hpp';
import pinoHttp from 'pino-http';
import { rateLimit } from 'express-rate-limit';
import { env } from './config/env';

export const app = express();

// Security headers
app.use(helmet());
app.use(hpp());
app.disable('x-powered-by');

// Trust proxy if we are behind a load balancer/reverse proxy
app.set('trust proxy', 1);

// CORS
app.use(cors({
  origin: env.FRONTEND_URL,
  optionsSuccessStatus: 200
}));

// Logging
app.use(pinoHttp({
  redact: [
    'req.headers.authorization',
    'req.headers.cookie',
    'req.headers["stripe-signature"]',
    'req.body.email',
    'req.body.phone',
    'req.body.turnstileToken'
  ],
}));

// Rate limiting (global)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use(globalLimiter);

// Strict Rate Limiting
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // strict limit
  message: 'Too many requests from this IP, please try again later.'
});

// Stripe Webhook MUST be parsed as raw body
// We mount it here before express.json()
import { stripeWebhookRouter } from './routes/webhooks';
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);

// Body parsers for the rest of the application
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Health check
app.get('/api/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Root check
app.get('/', (req: Request, res: Response) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'Maple Leaf Moving Co. Backend is online!',
    timestamp: new Date().toISOString() 
  });
});

import { checkoutRouter } from './routes/checkout';
import { contactRouter } from './routes/contact';
import { mapsRouter } from './routes/maps';
import { quotesRouter } from './routes/quotes';
import { ordersRouter } from './routes/orders';

// Routes
app.use('/api/checkout/instant', strictLimiter);
app.use('/api/checkout', checkoutRouter);

app.use('/api/contact', strictLimiter, contactRouter);

app.use('/api/maps', strictLimiter, mapsRouter);

app.use('/api/quotes/preview', strictLimiter);
app.use('/api/quotes', quotesRouter);

app.use('/api/orders', ordersRouter);

// Global error handler
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  req.log.error(err);
  
  const status = err.status || 500;
  const message = status === 500 ? 'Internal Server Error' : err.message;
  
  res.status(status).json({
    error: {
      message,
      requestId: req.id
    }
  });
});
