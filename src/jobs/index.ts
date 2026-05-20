import type { FastifyBaseLogger } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import { registerExampleJob } from './example.job';
import { registerUnipileFollowUpJob } from './unipile-follow-up.job';

let tasks: ScheduledTask[] = [];

export function startJobs(log: FastifyBaseLogger): void {
  if (process.env.DISABLE_JOBS === 'true') {
    log.warn('Cron jobs deshabilitados por DISABLE_JOBS=true');
    return;
  }

  tasks = [registerExampleJob(log), registerUnipileFollowUpJob(log)];
  log.info({ count: tasks.length }, 'Cron jobs iniciados');
}

export function stopJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}
