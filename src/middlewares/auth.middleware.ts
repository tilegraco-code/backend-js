import { FastifyReply, FastifyRequest } from 'fastify';

export async function internalTokenAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  // Aceptamos dos secretos compartidos: INTERNAL_API_KEY (el que usa el proxy
  // del Next.js para /api/messages/send) e INTERNAL_TOKEN (legacy, resto de /api).
  const expected = [process.env.INTERNAL_API_KEY, process.env.INTERNAL_TOKEN].filter(
    (v): v is string => Boolean(v),
  );
  if (expected.length === 0) {
    request.log.warn(
      'INTERNAL_API_KEY/INTERNAL_TOKEN no configurados — auth deshabilitada',
    );
    return;
  }

  const provided =
    (request.headers['x-internal-token'] as string | undefined) ??
    request.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (!provided || !expected.includes(provided)) {
    reply.status(401).send({ error: 'Unauthorized' });
  }
}
