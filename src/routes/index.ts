import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.route';
import { exampleRoute } from './example.route';
import { webhookRoutes } from './webhooks';
import { evolutionWebhookRoutes } from './webhooks/evolution.route';
import { adminFollowUpRoute } from './admin/follow-up.route';
import { internalTokenAuth } from '../middlewares/auth.middleware';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  // Webhooks públicos (cada uno con su propio auth: query token / connection_token)
  await app.register(webhookRoutes, { prefix: '/webhooks' });

  // Webhook de Evolution: la URL ya registrada en Evolution es
  // BACKEND_PUBLIC_URL/api/webhooks/evolution/:clientId. Se registra fuera del
  // scope /api (que exige internalTokenAuth) porque trae su propio Bearer.
  await app.register(evolutionWebhookRoutes, { prefix: '/api/webhooks' });

  await app.register(
    async (api) => {
      api.addHook('onRequest', internalTokenAuth);
      await api.register(exampleRoute, { prefix: '/example' });
      await api.register(adminFollowUpRoute, { prefix: '/admin' });
    },
    { prefix: '/api' },
  );
}
