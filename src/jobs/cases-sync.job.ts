import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { caseSyncService } from '../services/case-sync.service';

// Cada 30 segundos: lleva al Drive y al Sheet del cliente los casos que cambiaron.
// Ver docs/documentos-y-casos-plan.md. Reintentos con backoff en la propia fila.
const DEFAULT_SCHEDULE = '*/30 * * * * *';

export function registerCasesSyncJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.CASES_SYNC_CRON ?? DEFAULT_SCHEDULE;
  // Un caso con varios archivos puede tardar más que el intervalo.
  let running = false;

  const task = cron.schedule(
    schedule,
    async () => {
      if (running) return;
      running = true;
      const jobLog = log.child({ job: 'cases-sync' });
      try {
        const { claimed, synced } = await caseSyncService.syncBatch(jobLog);
        if (claimed > 0) jobLog.info({ claimed, synced }, 'cases-sync: pasada');
      } catch (err) {
        jobLog.error({ err }, 'cases-sync cron error');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'cases-sync', schedule }, 'cases-sync.job registrado');
  return task;
}
