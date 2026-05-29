import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { getOwnerEmail } from '../lib/owner-email';
import { emailService, accountLifecycleEmails } from './email.service';
import { disconnectAndDeleteClientChannels } from './channel-disconnect.service';

const DEFAULT_GRACE_HOURS = 24;

type Reason = 'trial_expired' | 'payment_overdue';
type Stage = 'warning' | 'cut';

export type LifecycleSummary = {
  trialWarnings: number;
  trialCuts: number;
  planWarnings: number;
  planCuts: number;
  channelsDeleted: number;
  errors: number;
  dryRun: boolean;
};

function isDryRun(): boolean {
  return process.env.ACCOUNT_LIFECYCLE_DRY_RUN === 'true';
}

function getGraceMs(): number {
  const hours = Number(process.env.ACCOUNT_LIFECYCLE_GRACE_HOURS ?? DEFAULT_GRACE_HOURS);
  const safe = Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_GRACE_HOURS;
  return safe * 3600_000;
}

async function logRun(
  clientId: number,
  reason: Reason,
  stage: Stage,
  channelsDeleted: number,
  emailTo: string | null,
  dryRun: boolean,
  log: FastifyBaseLogger,
): Promise<void> {
  const { error } = await supabase.from('account_lifecycle_log').insert({
    client_id: clientId,
    reason,
    stage,
    channels_deleted: channelsDeleted,
    email_to: emailTo,
    dry_run: dryRun,
  });
  if (error) {
    log.error({ err: error, client_id: clientId, reason, stage }, 'account_lifecycle_log insert error');
  }
}

export const accountLifecycleService = {
  /**
   * Avisa a trials que vencen dentro de la ventana de gracia y todavía no
   * recibieron el aviso. trial_ends_at != null implica que no avanzaron a un
   * plan pago (el webhook de MercadoPago lo pone en null al autorizar).
   */
  async runTrialWarnings(dryRun: boolean, log: FastifyBaseLogger): Promise<{ sent: number; errors: number }> {
    const now = new Date();
    const upper = new Date(now.getTime() + getGraceMs()).toISOString();

    const { data, error } = await supabase
      .from('client')
      .select('client_id, trial_ends_at')
      .not('trial_ends_at', 'is', null)
      .gt('trial_ends_at', now.toISOString())
      .lte('trial_ends_at', upper)
      .is('trial_warning_sent_at', null);

    if (error) {
      log.error({ err: error }, 'runTrialWarnings: query error');
      return { sent: 0, errors: 1 };
    }

    const clients = data ?? [];
    log.info({ count: clients.length }, 'trial-warning: candidatos');
    let sent = 0;
    let errors = 0;

    for (const c of clients) {
      const clientId = c.client_id as number;
      try {
        const email = await getOwnerEmail(clientId, log);
        if (!dryRun && email) {
          const { subject, html } = accountLifecycleEmails.trialWarning();
          await emailService.send(email, subject, html, log);
        }
        if (!dryRun) {
          await supabase
            .from('client')
            .update({ trial_warning_sent_at: now.toISOString() })
            .eq('client_id', clientId);
        }
        await logRun(clientId, 'trial_expired', 'warning', 0, email, dryRun, log);
        sent++;
      } catch (err) {
        errors++;
        log.error({ err, client_id: clientId }, 'trial-warning: error');
      }
    }

    return { sent, errors };
  },

  /**
   * Desconecta canales de trials vencidos hace más de la gracia que no
   * avanzaron a un plan. Verifica defensivamente que no exista billing
   * autorizado antes de cortar (por si el webhook no limpió trial_ends_at).
   */
  async runTrialCuts(
    dryRun: boolean,
    log: FastifyBaseLogger,
  ): Promise<{ cuts: number; channels: number; errors: number }> {
    const now = new Date();
    const threshold = new Date(now.getTime() - getGraceMs()).toISOString();

    const { data, error } = await supabase
      .from('client')
      .select('client_id, trial_ends_at')
      .not('trial_ends_at', 'is', null)
      .lte('trial_ends_at', threshold)
      .is('trial_disconnected_at', null);

    if (error) {
      log.error({ err: error }, 'runTrialCuts: query error');
      return { cuts: 0, channels: 0, errors: 1 };
    }

    const clients = data ?? [];
    if (clients.length === 0) {
      log.info('trial-cut: sin candidatos');
      return { cuts: 0, channels: 0, errors: 0 };
    }

    // Salvaguarda: excluir clientes con billing autorizado.
    const ids = clients.map((c) => c.client_id as number);
    const { data: paidRows } = await supabase
      .from('client_billing')
      .select('client_id')
      .in('client_id', ids)
      .eq('status', 'authorized');
    const paid = new Set((paidRows ?? []).map((r) => r.client_id as number));

    log.info({ count: clients.length, skipped_paid: paid.size }, 'trial-cut: candidatos');
    let cuts = 0;
    let channels = 0;
    let errors = 0;

    for (const c of clients) {
      const clientId = c.client_id as number;
      if (paid.has(clientId)) {
        log.warn({ client_id: clientId }, 'trial-cut: cliente con billing autorizado — se saltea');
        continue;
      }
      try {
        const deleted = await disconnectAndDeleteClientChannels(clientId, dryRun, log);
        const email = await getOwnerEmail(clientId, log);
        if (!dryRun && email) {
          const { subject, html } = accountLifecycleEmails.trialCut();
          await emailService.send(email, subject, html, log);
        }
        if (!dryRun) {
          await supabase
            .from('client')
            .update({ trial_disconnected_at: now.toISOString() })
            .eq('client_id', clientId);
        }
        await logRun(clientId, 'trial_expired', 'cut', deleted, email, dryRun, log);
        cuts++;
        channels += deleted;
      } catch (err) {
        errors++;
        log.error({ err, client_id: clientId }, 'trial-cut: error');
      }
    }

    return { cuts, channels, errors };
  },

  /**
   * Avisa a planes cuyo próximo pago vence dentro de la ventana de gracia.
   */
  async runPlanWarnings(dryRun: boolean, log: FastifyBaseLogger): Promise<{ sent: number; errors: number }> {
    const now = new Date();
    const upper = new Date(now.getTime() + getGraceMs()).toISOString();

    const { data, error } = await supabase
      .from('client_billing')
      .select('client_id, next_payment_date')
      .eq('status', 'authorized')
      .not('next_payment_date', 'is', null)
      .gt('next_payment_date', now.toISOString())
      .lte('next_payment_date', upper)
      .is('payment_warning_sent_at', null);

    if (error) {
      log.error({ err: error }, 'runPlanWarnings: query error');
      return { sent: 0, errors: 1 };
    }

    const rows = data ?? [];
    log.info({ count: rows.length }, 'plan-warning: candidatos');
    let sent = 0;
    let errors = 0;

    for (const row of rows) {
      const clientId = row.client_id as number;
      try {
        const email = await getOwnerEmail(clientId, log);
        if (!dryRun && email) {
          const { subject, html } = accountLifecycleEmails.planWarning();
          await emailService.send(email, subject, html, log);
        }
        if (!dryRun) {
          await supabase
            .from('client_billing')
            .update({ payment_warning_sent_at: now.toISOString() })
            .eq('client_id', clientId);
        }
        await logRun(clientId, 'payment_overdue', 'warning', 0, email, dryRun, log);
        sent++;
      } catch (err) {
        errors++;
        log.error({ err, client_id: clientId }, 'plan-warning: error');
      }
    }

    return { sent, errors };
  },

  /**
   * Desconecta TODOS los canales de clientes con plan cuyo pago venció hace
   * más de la gracia y no se renovó (next_payment_date sigue en el pasado).
   */
  async runPlanCuts(
    dryRun: boolean,
    log: FastifyBaseLogger,
  ): Promise<{ cuts: number; channels: number; errors: number }> {
    const now = new Date();
    const threshold = new Date(now.getTime() - getGraceMs()).toISOString();

    const { data, error } = await supabase
      .from('client_billing')
      .select('client_id, next_payment_date')
      .eq('status', 'authorized')
      .not('next_payment_date', 'is', null)
      .lte('next_payment_date', threshold)
      .is('disconnected_at', null);

    if (error) {
      log.error({ err: error }, 'runPlanCuts: query error');
      return { cuts: 0, channels: 0, errors: 1 };
    }

    const rows = data ?? [];
    log.info({ count: rows.length }, 'plan-cut: candidatos');
    let cuts = 0;
    let channels = 0;
    let errors = 0;

    for (const row of rows) {
      const clientId = row.client_id as number;
      try {
        const deleted = await disconnectAndDeleteClientChannels(clientId, dryRun, log);
        const email = await getOwnerEmail(clientId, log);
        if (!dryRun && email) {
          const { subject, html } = accountLifecycleEmails.planCut();
          await emailService.send(email, subject, html, log);
        }
        if (!dryRun) {
          await supabase
            .from('client_billing')
            .update({ disconnected_at: now.toISOString(), status: 'paused' })
            .eq('client_id', clientId);
        }
        await logRun(clientId, 'payment_overdue', 'cut', deleted, email, dryRun, log);
        cuts++;
        channels += deleted;
      } catch (err) {
        errors++;
        log.error({ err, client_id: clientId }, 'plan-cut: error');
      }
    }

    return { cuts, channels, errors };
  },

  async runBatch(log: FastifyBaseLogger): Promise<LifecycleSummary> {
    const dryRun = isDryRun();
    log.info({ dryRun, graceHours: getGraceMs() / 3600_000 }, 'account-lifecycle: batch iniciado');

    const trialWarn = await this.runTrialWarnings(dryRun, log);
    const trialCut = await this.runTrialCuts(dryRun, log);
    const planWarn = await this.runPlanWarnings(dryRun, log);
    const planCut = await this.runPlanCuts(dryRun, log);

    const summary: LifecycleSummary = {
      trialWarnings: trialWarn.sent,
      trialCuts: trialCut.cuts,
      planWarnings: planWarn.sent,
      planCuts: planCut.cuts,
      channelsDeleted: trialCut.channels + planCut.channels,
      errors: trialWarn.errors + trialCut.errors + planWarn.errors + planCut.errors,
      dryRun,
    };

    log.info(summary, 'account-lifecycle: batch terminado');
    return summary;
  },
};
