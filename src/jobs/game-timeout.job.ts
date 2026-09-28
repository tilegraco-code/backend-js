import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { gameService } from '../game/game.service';

// Cada 30 segundos: cierra como `abandoned` las partidas del juego del stand que pasaron
// el límite de tiempo, y le avisa al jugador. Ver src/game/game.service.ts.
const DEFAULT_SCHEDULE = '*/30 * * * * *';

export function registerGameTimeoutJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.GAME_TIMEOUT_CRON ?? DEFAULT_SCHEDULE;
  let running = false;

  const task = cron.schedule(
    schedule,
    async () => {
      // Sin inbox del juego configurado no hay partidas que vigilar.
      if (running || !process.env.GAME_UNIPILE_ACCOUNT_ID) return;
      running = true;
      const jobLog = log.child({ job: 'game-timeout' });
      try {
        const closed = await gameService.abandonStale(jobLog);
        if (closed > 0) jobLog.info({ closed }, 'game-timeout: partidas cerradas');
      } catch (err) {
        jobLog.error({ err }, 'game-timeout cron error');
      } finally {
        running = false;
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'game-timeout', schedule }, 'game-timeout.job registrado');
  return task;
}
