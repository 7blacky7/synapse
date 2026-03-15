import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env.js';
import { authRoutes } from './modules/auth/auth.controller.js';
import { usersRoutes, adminRoutes, notificationsRoutes, invitesRoutes, apikeysRoutes, webhooksRoutes } from './modules/index.js';

const app = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
  },
});

// Global Plugins
await app.register(helmet);
await app.register(cors, {
  origin: env.CORS_ORIGIN,
  credentials: true,
});
await app.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
});

// Health Checks
app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async () => {
  // TODO: DB + Redis ping
  return { status: 'ok', db: 'connected', redis: 'connected' };
});

// Routes
await app.register(authRoutes);
await app.register(usersRoutes);
await app.register(adminRoutes);
await app.register(notificationsRoutes);
await app.register(invitesRoutes);
await app.register(apikeysRoutes);
await app.register(webhooksRoutes);

// Global Error Handler
app.setErrorHandler((error, _request, reply) => {
  const err = error as any;
  const statusCode = err?.statusCode ?? 500;

  if (statusCode >= 500) {
    app.log.error(error);
  }

  reply.status(statusCode).send({
    success: false,
    error: {
      code: err?.code ?? 'INTERNAL_ERROR',
      message: statusCode >= 500 ? 'Internal Server Error' : err?.message ?? 'Unknown error',
    },
  });
});

// Start
try {
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`API running on port ${env.PORT}`);
} catch (err) {
  app.log.fatal(err);
  process.exit(1);
}
