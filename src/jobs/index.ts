import type { FastifyBaseLogger } from 'fastify';
import type { ScheduledTask } from 'node-cron';
import { registerExampleJob } from './example.job';
import { registerUnipileFollowUpJob } from './unipile-follow-up.job';
import { registerAccountLifecycleJob } from './account-lifecycle.job';
import { registerUsageBillingJob } from './usage-billing.job';
import { registerLearningsJob } from './learnings.job';
import { registerTokenBackfillJob } from './usage-tokens.job';
import { registerMercadolibreQuestionsPollJob } from './mercadolibre-questions-poll.job';
import { registerChatDocumentsProcessJob } from './chat-documents-process.job';
import { registerCasesSyncJob } from './cases-sync.job';
import { registerCaseNotifyJob } from './case-notify.job';

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
    registerMercadolibreQuestionsPollJob(log),
    registerChatDocumentsProcessJob(log),
    registerCasesSyncJob(log),
    registerCaseNotifyJob(log),
  ];
  log.info({ count: tasks.length }, 'Cron jobs iniciados');
}

export function stopJobs(): void {
  for (const task of tasks) {
    task.stop();
  }
  tasks = [];
}
