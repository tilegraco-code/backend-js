import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { mercadolibreQuestionsService } from '../services/mercadolibre-questions.service';

// Cada 2 minutos: respaldo de las notificaciones del tópico `questions` de MercadoLibre.
// ML descarta una notificación tras 5 intentos fallidos; esto recupera esas preguntas.
// Ver mercadolibreQuestionsService.pollUnanswered.
const DEFAULT_SCHEDULE = '*/2 * * * *';

export function registerMercadolibreQuestionsPollJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.ML_QUESTIONS_POLL_CRON ?? DEFAULT_SCHEDULE;
  // Una pasada con varios turnos del agente puede durar más que el intervalo: sin esto
  // se solaparían dos barridos sobre las mismas preguntas.
  let running = false;

  const task = cron.schedule(
    schedule,
    async () => {
      if (running) return;
      running = true;
      const jobLog = log.child({ job: 'ml-questions-poll' });
      try {
        const { accounts, found } = await mercadolibreQuestionsService.pollUnanswered(jobLog);
        if (found > 0) jobLog.info({ accounts, found }, 'ml-questions-poll: preguntas recuperadas');
      } catch (err) {
        jobLog.error({ err }, 'ml-questions-poll cron error');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'ml-questions-poll', schedule }, 'mercadolibre-questions-poll.job registrado');
  return task;
}
