import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';

export function registerExampleJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = '0 * * * *';

  const task = cron.schedule(
    schedule,
    async () => {
      log.info({ job: 'example' }, 'Ejecutando example.job');
      try {
        const { count, error } = await supabase
          .from('examples')
          .select('*', { count: 'exact', head: true });

        if (error) throw error;
        log.info({ job: 'example', count }, 'example.job completado');
      } catch (err) {
        log.error({ job: 'example', err }, 'Error en example.job');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'example', schedule }, 'example.job registrado');
  return task;
}
