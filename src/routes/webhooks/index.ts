import { FastifyInstance } from 'fastify';
import { unipileWebhookRoutes } from './unipile.route';

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  await app.register(unipileWebhookRoutes);
}
