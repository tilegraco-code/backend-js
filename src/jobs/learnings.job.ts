import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { runLearningsIngestion } from '../services/learnings.service';

// Cada 15 minutos: trae los errores nuevos de n8n de cada agente y los resume para la
// tab Aprendizaje. Idempotente (dedupe por execution_id), así que correr seguido no duplica.
const DEFAULT_SCHEDULE = '*/15 * * * *';

export function registerLearningsJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.LEARNINGS_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'learnings' });
      jobLog.info('cron tick');
      try {
        const { created } = await runLearningsIngestion(jobLog);
        if (created > 0) jobLog.info({ created }, 'learnings: aprendizajes creados');
      } catch (err) {
        jobLog.error({ err }, 'learnings cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'learnings', schedule }, 'learnings.job registrado');
  return task;
}
