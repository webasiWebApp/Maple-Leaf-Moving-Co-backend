import { app } from './app';
import { env } from './config/env';

const PORT = Number(process.env.PORT) || 8080;

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server is running on port ${PORT} in ${env.NODE_ENV} mode`);
});

// Handle graceful shutdown
const shutdown = () => {
  console.log('Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
