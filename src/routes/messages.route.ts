import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { outgoingMessageService } from '../services/outgoing-message.service';

const sendBodySchema = z.object({
  client_id: z.number().int().positive(),
  chat_id: z.string().min(1),
  text: z.string().trim().min(1),
});

const sendResponseSchema = z.object({
  ok: z.literal(true),
  message_id: z.string(),
});

const errorResponseSchema = z.object({
  error: z.string(),
});

export async function messagesRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/messages/send — proxy fino del Next.js. Resuelve el provider del
  // chat (WEB / Unipile / Evolution) y envía por el protocolo correcto.
  r.post(
    '/send',
    {
      schema: {
        tags: ['messages'],
        summary: 'Enviar mensaje saliente (resuelve provider del chat)',
        security: [{ InternalToken: [] }],
        body: sendBodySchema,
        response: {
          200: sendResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { client_id, chat_id, text } = request.body;

      const result = await outgoingMessageService.sendOutgoing(
        { clientId: client_id, chatId: chat_id, text },
        request.log,
      );

      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }

      return reply.send({ ok: true, message_id: result.message_id });
    },
  );
}
