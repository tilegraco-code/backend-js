import type { FastifyBaseLogger } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import { registerExampleJob } from './example.job';
import { registerUnipileFollowUpJob } from './unipile-follow-up.job';
import { registerAccountLifecycleJob } from './account-lifecycle.job';
import { registerUsageBillingJob } from './usage-billing.job';
import { registerLearningsJob } from './learnings.job';
import { registerTokenBackfillJob } from './usage-tokens.job';

let tasks: ScheduledTask[] = [];

export function startJobs(log: FastifyBaseLogger): void {
  if (process.env.DISABLE_JOBS === 'true') {
    log.warn('Cron jobs deshabilitados por DISABLE_JOBS=true');
    return;
  }

  tasks = [
    registerExampleJob(log),
    registerUnipileFollowUpJob(log),
    registerAccountLifecycleJob(log),
    registerUsageBillingJob(log),
    registerLearningsJob(log),
    registerTokenBackfillJob(log),
  ];
  log.info({ count: tasks.length }, 'Cron jobs iniciados');
}

export function stopJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}
