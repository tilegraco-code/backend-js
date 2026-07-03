import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { runUsageBillingBatch } from '../services/usage-billing.service';

// Día 1 de cada mes, 14:00 UTC ≈ 11:00 AM Argentina. Factura el excedente del
// mes calendario que acaba de cerrar.
const DEFAULT_SCHEDULE = '0 14 1 * *';

export function registerUsageBillingJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.USAGE_BILLING_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'usage-billing' });
      jobLog.info('cron tick');
      try {
        await runUsageBillingBatch(jobLog);
      } catch (err) {
        jobLog.error({ err }, 'usage-billing cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'usage-billing', schedule }, 'usage-billing.job registrado');
  return task;
}
