import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.route';
import { exampleRoute } from './example.route';
import { internalTokenAuth } from '../middlewares/auth.middleware';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  await app.register(
    async (api) => {
      api.addHook('onRequest', internalTokenAuth);
      await api.register(exampleRoute, { prefix: '/example' });
    },
    { prefix: '/api' },
  );
}
