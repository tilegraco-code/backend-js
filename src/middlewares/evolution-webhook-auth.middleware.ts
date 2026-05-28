import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Valida el header `Authorization: Bearer <token>` contra EVOLUTION_WEBHOOK_SECRET.
 * Se usa para /api/webhooks/evolution/:clientId.
 *
 * El header se inyecta al crear la instancia en Evolution (createEvolutionInstance
 * en el dashboard), por eso acá validamos el header y no un query token como Unipile.
 */
export async function evolutionWebhookAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = process.env.EVOLUTION_WEBHOOK_SECRET;
  if (!expected) {
    request.log.error('EVOLUTION_WEBHOOK_SECRET no está configurado');
    reply.status(500).send({ error: 'Webhook secret not configured' });
    return;
  }

  const authHeader = request.headers.authorization ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    reply.status(401).send({ error: 'Missing token' });
    return;
  }

  if (token !== expected) {
    reply.status(401).send({ error: 'Invalid token' });
    return;
  }
}
