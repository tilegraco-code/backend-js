import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { runTokenBackfill } from '../services/usage-tokens.service';

// Cada 5 minutos: completa input_tokens/output_tokens de las filas de agentuse que tienen
// execution_id pero todavía no fueron sincronizadas. Idempotente (flag tokens_synced).
const DEFAULT_SCHEDULE = '*/5 * * * *';

export function registerTokenBackfillJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.TOKENS_BACKFILL_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'token-backfill' });
      try {
        const { updated } = await runTokenBackfill(jobLog);
        if (updated > 0) jobLog.info({ updated }, 'token-backfill: filas actualizadas');
      } catch (err) {
        jobLog.error({ err }, 'token-backfill cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'token-backfill', schedule }, 'usage-tokens.job registrado');
  return task;
}
