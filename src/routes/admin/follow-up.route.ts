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

const resetBodySchema = z.object({
  chatId: z.string().min(1),
});

const resetResponseSchema = z.object({
  ok: z.boolean(),
  found: z.boolean(),
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

  r.post(
    '/follow-up/reset',
    {
      schema: {
        tags: ['admin'],
        summary: 'Reactivar el seguimiento de un chat',
        description:
          'Pone `follow_up_sent_at` en null para que el chat vuelva a ser candidato del cron. ' +
          'No fuerza el envío: respeta las condiciones (open, +24h inactivo, workflow habilitado). ' +
          '`found` es false si no existe un chat con ese chat_id.',
        security: [{ InternalToken: [] }],
        body: resetBodySchema,
        response: { 200: resetResponseSchema },
      },
    },
    async (request) => {
      const { chatId } = request.body;
      const found = await unipileFollowUpService.resetFollowUp(chatId, request.log);
      return { ok: true, found };
    },
  );
}
