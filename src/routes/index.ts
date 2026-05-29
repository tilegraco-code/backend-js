import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.route';
import { exampleRoute } from './example.route';
import { webhookRoutes } from './webhooks';
import { messagesRoute } from './messages.route';
import { adminFollowUpRoute } from './admin/follow-up.route';
import { adminAccountLifecycleRoute } from './admin/account-lifecycle.route';
import { internalTokenAuth } from '../middlewares/auth.middleware';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  // Webhooks públicos (Unipile + Evolution), cada uno con su propio auth
  // (query token / connection_token / Bearer header). El dashboard registra las
  // URLs bajo /api/webhooks/..., y como es un plugin propio NO hereda el
  // internalTokenAuth del scope /api de más abajo (los hooks son encapsulados).
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });

  await app.register(
    async (api) => {
      api.addHook('onRequest', internalTokenAuth);
      await api.register(exampleRoute, { prefix: '/example' });
      await api.register(messagesRoute, { prefix: '/messages' });
      await api.register(adminFollowUpRoute, { prefix: '/admin' });
      await api.register(adminAccountLifecycleRoute, { prefix: '/admin' });
    },
    { prefix: '/api' },
  );
}
