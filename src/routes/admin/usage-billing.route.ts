import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { runUsageBillingBatch } from '../../services/usage-billing.service';

const bodySchema = z
  .object({
    // Período a facturar en formato 'YYYY-MM'. Si se omite, se usa el mes
    // calendario anterior (lo que haría el cron del día 1).
    period: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'period debe tener formato YYYY-MM')
      .optional(),
  })
  .optional();

const runResponseSchema = z.object({
  period: z.string(),
  clientsProcessed: z.number(),
  clientsBillable: z.number(),
  totalBillableUses: z.number(),
  totalAmountArs: z.number(),
  clientsSynced: z.number(),
  skippedPaid: z.number(),
  errors: z.number(),
  dryRun: z.boolean(),
});

function rangeFromPeriod(period: string): { period: string; from: Date; to: Date } {
  const [y, m] = period.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  return { period, from, to };
}

export async function adminUsageBillingRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/usage-billing/run',
    {
      schema: {
        tags: ['admin'],
        summary: 'Forzar el cálculo de excedente de usos (créditos)',
        description:
          'Corre `runUsageBillingBatch` on-demand para un período (por defecto el mes ' +
          'calendario anterior). Escribe items en usage_billing_items y dispara el sync del ' +
          'preapproval en el dashboard. Respeta USAGE_BILLING_DRY_RUN. No pisa items ya pagados.',
        security: [{ InternalToken: [] }],
        body: bodySchema,
        response: { 200: runResponseSchema },
      },
    },
    async (request) => {
      const period = request.body?.period;
      return runUsageBillingBatch(request.log, period ? { period: rangeFromPeriod(period) } : {});
    },
  );
}
