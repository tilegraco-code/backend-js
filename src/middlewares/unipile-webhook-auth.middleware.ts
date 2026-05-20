import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Valida el query param ?token=... contra UNIPILE_WEBHOOK_SECRET.
 * Se usa para /webhooks/unipile/:clientId (mensajes) y /webhooks/unipile/accounts (status).
 *
 * El callback /webhooks/unipile/:clientId/account-connected NO usa este middleware:
 * su token es un connection_token por inbox que se valida contra la fila en DB.
 */
export async function unipileWebhookAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!expected) {
    request.log.error('UNIPILE_WEBHOOK_SECRET no está configurado');
    reply.status(500).send({ error: 'Webhook secret not configured' });
    return;
  }

  const token = (request.query as { token?: string })?.token ?? '';
  if (!token) {
    reply.status(401).send({ error: 'Missing token' });
    return;
  }

  if (token !== expected) {
    reply.status(401).send({ error: 'Invalid token' });
    return;
  }
}
