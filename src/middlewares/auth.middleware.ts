import { FastifyReply, FastifyRequest } from 'fastify';

export async function internalTokenAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = process.env.INTERNAL_TOKEN;
  if (!expected) {
    request.log.warn('INTERNAL_TOKEN no está configurado — auth deshabilitada');
    return;
  }

  const provided =
    (request.headers['x-internal-token'] as string | undefined) ??
    request.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (provided !== expected) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}
