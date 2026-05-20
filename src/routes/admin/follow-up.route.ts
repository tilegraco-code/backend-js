import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unipileFollowUpService } from '../../services/unipile-follow-up.service';

const runQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

const runResponseSchema = z.object({
  candidates: z.number(),
  processed: z.number(),
  deferred: z.number(),
  workflows: z.number(),
  sent: z.number(),
  errors: z.number(),
  dryRun: z.boolean(),
});

export async function adminFollowUpRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/follow-up/run',
    {
      schema: {
        tags: ['admin'],
        summary: 'Forzar ejecución del batch de follow-up',
        description:
          'Corre `unipileFollowUpService.runBatch` on-demand. Respeta FOLLOW_UP_DRY_RUN. ' +
          'En modo real hay un delay de 20-30s entre envíos: con N candidatos la corrida tarda ~25*(N-1)s. ' +
          'Usá `?limit=N` para probar con pocos chats. ' +
          'OJO: para batches grandes el cliente HTTP puede timeoutear (Traefik/proxy ~60s) pero el server termina igual.',
        security: [{ InternalToken: [] }],
        querystring: runQuerySchema,
        response: { 200: runResponseSchema },
      },
    },
    async (request) => {
      const { limit } = request.query;
      const result = await unipileFollowUpService.runBatch(request.log, { limit });
      return { ...result, dryRun: process.env.FOLLOW_UP_DRY_RUN === 'true' };
    },
  );
}
