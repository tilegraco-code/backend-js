import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mercadolibreQuestionsService } from '../services/mercadolibre-questions.service';

const errorResponseSchema = z.object({ error: z.string() });

/**
 * Rutas internas de MercadoLibre (Bearer interno). Las llama el dashboard, que no
 * tiene los tokens de ML: el acceso del usuario al client_id lo valida él antes.
 */
export async function mercadolibreRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/mercadolibre/questions/:questionId/answer → respuesta manual desde la tab del Inbox.
  r.post(
    '/questions/:questionId/answer',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Responde a mano una pregunta de una publicación (con la firma del canal)',
        security: [{ InternalToken: [] }],
        params: z.object({ questionId: z.coerce.number().int().positive() }),
        body: z.object({
          client_id: z.number().int().positive(),
          text: z.string().min(1),
        }),
        response: {
          200: z.object({ ok: z.literal(true), answer: z.string() }),
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await mercadolibreQuestionsService.answerManually(
        {
          clientId: request.body.client_id,
          questionId: request.params.questionId,
          text: request.body.text,
        },
        request.log,
      );
      if (!result.ok) {
        return reply.status(result.status as 400 | 404 | 409 | 502).send({ error: result.error });
      }
      return { ok: true as const, answer: result.answer };
    },
  );
}
