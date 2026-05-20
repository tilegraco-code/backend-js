import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.route';
import { exampleRoute } from './example.route';
import { webhookRoutes } from './webhooks';
import { internalTokenAuth } from '../middlewares/auth.middleware';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  // Webhooks públicos (cada uno con su propio auth: query token / connection_token)
  await app.register(webhookRoutes, { prefix: '/webhooks' });

  await app.register(
    async (api) => {
      api.addHook('onRequest', internalTokenAuth);
      await api.register(exampleRoute, { prefix: '/example' });
    },
    { prefix: '/api' },
  );
}
