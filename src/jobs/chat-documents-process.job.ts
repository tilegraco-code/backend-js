import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { chatDocumentsService } from '../services/chat-documents.service';

// Cada 10 segundos: procesa los documentos recibidos que están en cola (clasificación,
// texto, legibilidad) llamando a agente-tilegra. Ver docs/documentos-y-casos-plan.md.
// El reintento con backoff lo maneja la propia fila (next_attempt_at).
const DEFAULT_SCHEDULE = '*/10 * * * * *';

export function registerChatDocumentsProcessJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.CHAT_DOCUMENTS_CRON ?? DEFAULT_SCHEDULE;
  // El claim ya evita procesar dos veces la misma fila; esto evita apilar pasadas cuando
  // un PDF escaneado tarda más que el intervalo.
  let running = false;

  const task = cron.schedule(
    schedule,
    async () => {
      if (running) return;
      running = true;
      const jobLog = log.child({ job: 'chat-documents-process' });
      try {
        const { claimed, ready } = await chatDocumentsService.processBatch(jobLog);
        if (claimed > 0) jobLog.info({ claimed, ready }, 'chat-documents: pasada de la cola');
      } catch (err) {
        jobLog.error({ err }, 'chat-documents-process cron error');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'chat-documents-process', schedule }, 'chat-documents-process.job registrado');
  return task;
}
