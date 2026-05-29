import cron, { ScheduledTask } from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { accountLifecycleService } from '../services/account-lifecycle.service';

const DEFAULT_SCHEDULE = '0 13 * * *'; // 13:00 UTC ≈ 10:00 AM Argentina

export function registerAccountLifecycleJob(log: FastifyBaseLogger): ScheduledTask {
  const schedule = process.env.ACCOUNT_LIFECYCLE_CRON ?? DEFAULT_SCHEDULE;

  const task = cron.schedule(
    schedule,
    async () => {
      const jobLog = log.child({ job: 'account-lifecycle' });
      jobLog.info('cron tick');
      try {
        await accountLifecycleService.runBatch(jobLog);
      } catch (err) {
        jobLog.error({ err }, 'account-lifecycle cron error');
      }
    },
    { scheduled: true, timezone: process.env.TZ ?? 'UTC' },
  );

  log.info({ job: 'account-lifecycle', schedule }, 'account-lifecycle.job registrado');
  return task;
}
