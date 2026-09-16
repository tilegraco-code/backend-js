import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { caseNotifyService } from '../services/case-notify.service';

// Cada 10 segundos: avisa al cliente los resultados de revisiones que terminaron después del
// turno. Ver case-notify.service.ts.
const DEFAULT_SCHEDULE = '*/10 * * * * *';

export function registerCaseNotifyJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.CASE_NOTIFY_CRON ?? DEFAULT_SCHEDULE;
  // Cada aviso es un turno completo del agente: puede tardar más que el intervalo.
  let running = false;

  const task = cron.schedule(
    schedule,
    async () => {
      if (running) return;
      running = true;
      const jobLog = log.child({ job: 'case-notify' });
      try {
        const { sent, skipped } = await caseNotifyService.runBatch(jobLog);
        if (sent + skipped > 0) jobLog.info({ sent, skipped }, 'case-notify: pasada');
      } catch (err) {
        jobLog.error({ err }, 'case-notify cron error');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'case-notify', schedule }, 'case-notify.job registrado');
  return task;
}
