import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { unipileFollowUpService } from '../services/unipile-follow-up.service';

const DEFAULT_SCHEDULE = '0 14 * * *'; // 14:00 UTC ≈ 11:00 AM Argentina

export function registerUnipileFollowUpJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.FOLLOW_UP_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'unipile-follow-up' });
      jobLog.info('cron tick');
      try {
        await unipileFollowUpService.runBatch(jobLog);
      } catch (err) {
        jobLog.error({ err }, 'follow-up cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'unipile-follow-up', schedule }, 'unipile-follow-up.job registrado');
  return task;
}
