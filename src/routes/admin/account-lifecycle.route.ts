import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { accountLifecycleService } from '../../services/account-lifecycle.service';

const runResponseSchema = z.object({
  trialWarnings: z.number(),
  trialCuts: z.number(),
  planWarnings: z.number(),
  planCuts: z.number(),
  channelsDeleted: z.number(),
  errors: z.number(),
  dryRun: z.boolean(),
});

export async function adminAccountLifecycleRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/account-lifecycle/run',
    {
      schema: {
        tags: ['admin'],
        summary: 'Forzar ejecución del batch de ciclo de vida de cuentas',
        description:
          'Corre `accountLifecycleService.runBatch` on-demand: avisa y desconecta trials vencidos ' +
          'y planes con pago vencido (tras la gracia configurada). Respeta ACCOUNT_LIFECYCLE_DRY_RUN.',
        security: [{ InternalToken: [] }],
        response: { 200: runResponseSchema },
      },
    },
    async (request) => {
      return accountLifecycleService.runBatch(request.log);
    },
  );
}
