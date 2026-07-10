import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { openaiService, FollowUpMessage } from './openai.service';
import { unipileApiService } from './unipile-api.service';

export type FollowUpCandidate = {
  id: number;
  chat_id: string;
  client_id: number;
  account_id: string;
  contact_name: string | null;
  workflow_id: number;
  provider: string | null;
};

const DEFAULT_INACTIVITY_HOURS = 24;
const LAST_N_MESSAGES = 10;
const DELAY_MIN_MS = 20_000;
const DELAY_MAX_MS = 30_000;
const DEFAULT_MAX_PER_WORKFLOW = 300;

function isDryRun(): boolean {
  return process.env.FOLLOW_UP_DRY_RUN === 'true';
}

function getInactivityCutoff(): string {
  const hours = Number(process.env.FOLLOW_UP_INACTIVITY_HOURS ?? DEFAULT_INACTIVITY_HOURS);
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function getMaxPerWorkflow(): number {
  const raw = Number(process.env.FOLLOW_UP_MAX_PER_WORKFLOW ?? DEFAULT_MAX_PER_WORKFLOW);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_PER_WORKFLOW;
}

function randomDelayMs(): number {
  return DELAY_MIN_MS + Math.floor(Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const unipileFollowUpService = {
  async listCandidates(log: FastifyBaseLogger): Promise<FollowUpCandidate[]> {
    const cutoff = getInactivityCutoff();

    const { data, error } = await supabase
      .from('unipile_chats')
      .select(
        `id, chat_id, client_id, account_id, contact_name, workflow_id, provider, last_message_at,
         workflow!inner ( follow_up_enabled )`,
      )
      .eq('status', 'open')
      .is('follow_up_sent_at', null)
      .lt('last_message_at', cutoff)
      .not('last_message_at', 'is', null)
      .not('workflow_id', 'is', null)
      .eq('workflow.follow_up_enabled', true)
      .order('last_message_at', { ascending: false });

    if (error) {
      log.error({ err: error }, 'listCandidates error');
      throw error;
    }

    return (data ?? []).map((row: Record<string, unknown>) => ({
      id: row.id as number,
      chat_id: row.chat_id as string,
      client_id: row.client_id as number,
      account_id: row.account_id as string,
      contact_name: (row.contact_name as string | null) ?? null,
      workflow_id: row.workflow_id as number,
      provider: (row.provider as string | null) ?? null,
    }));
  },

  /**
   * Reactiva el seguimiento de un chat poniendo `follow_up_sent_at` en null.
   * No fuerza el envío: el chat queda elegible para el próximo cron siempre que
   * vuelva a cumplir las condiciones (open, +24h inactivo, workflow habilitado).
   * Devuelve `true` si encontró y actualizó la fila.
   */
  async resetFollowUp(chatId: string, log: FastifyBaseLogger): Promise<boolean> {
    const { data, error } = await supabase
      .from('unipile_chats')
      .update({ follow_up_sent_at: null, updated_at: new Date().toISOString() })
      .eq('chat_id', chatId)
      .select('id');

    if (error) {
      log.error({ err: error, chat_id: chatId }, 'resetFollowUp error');
      throw error;
    }

    const found = (data?.length ?? 0) > 0;
    log.info({ chat_id: chatId, found }, 'follow-up reactivado');
    return found;
  },

  async runForChat(candidate: FollowUpCandidate, log: FastifyBaseLogger): Promise<void> {
    const chatLog = log.child({ chat_id: candidate.chat_id, client_id: candidate.client_id });

    // 1. Fetch últimos N mensajes
    const { data: messages, error: msgError } = await supabase
      .from('unipile_messages')
      .select('direction, content, created_at')
      .eq('chat_id', candidate.chat_id)
      .order('created_at', { ascending: false })
      .limit(LAST_N_MESSAGES);

    if (msgError) {
      chatLog.error({ err: msgError }, 'fetch messages error');
      return;
    }

    const ordered: FollowUpMessage[] = (messages ?? []).reverse().map((m) => ({
      direction: m.direction as 'incoming' | 'outgoing',
      content: m.content,
      created_at: m.created_at,
    }));

    if (ordered.length === 0) {
      chatLog.warn('chat sin mensajes — saltando follow-up');
      return;
    }

    // 2. Generar texto con GPT
    let text: string;
    try {
      text = await openaiService.generateFollowUp(ordered, candidate.contact_name);
      chatLog.info({ text, contact: candidate.contact_name }, 'follow-up generado por GPT');
    } catch (e) {
      chatLog.error({ err: e }, 'GPT generate error');
      return;
    }

    if (isDryRun()) {
      chatLog.info({ text }, 'DRY RUN — no se envía ni marca');
      return;
    }

    // 3. Enviar a Unipile
    let unipileMessageId: string;
    try {
      const sent = await unipileApiService.sendMessage(candidate.chat_id, text);
      unipileMessageId = (sent.id as string) ?? (sent.message_id as string) ?? crypto.randomUUID();
      chatLog.info({ unipileMessageId }, 'follow-up enviado vía Unipile');
    } catch (e) {
      chatLog.error({ err: e }, 'Unipile sendMessage error');
      return;
    }

    const now = new Date().toISOString();

    // 4. Insert en unipile_messages
    const { error: insertError } = await supabase.from('unipile_messages').insert({
      chat_id: candidate.chat_id,
      client_id: candidate.client_id,
      message_id: unipileMessageId,
      content: text,
      direction: 'outgoing',
      sender_name: null,
      created_at: now,
    });

    if (insertError) {
      chatLog.error({ err: insertError }, 'insert unipile_messages error');
      // No abortamos — el mensaje ya se envió. Aún queremos marcar follow_up_sent_at.
    }

    // 5. Update unipile_chats
    const { error: updateError } = await supabase
      .from('unipile_chats')
      .update({
        last_message_preview: text.slice(0, 120),
        last_message_at: now,
        follow_up_sent_at: now,
        updated_at: now,
      })
      .eq('id', candidate.id);

    if (updateError) {
      chatLog.error({ err: updateError }, 'update unipile_chats error');
      return;
    }

    chatLog.info('follow-up completado');
  },

  /**
   * Procesa una cola para un workflow específico: secuencial con sleep 20-30s entre envíos.
   * El rate limit de Unipile es por cuenta/workflow, así que distintos workflows pueden
   * correr sus colas en paralelo sin riesgo de ban.
   *
   * Al final inserta una fila en `unipile_follow_up_log` con las métricas de la corrida.
   */
  async processWorkflowQueue(
    workflowId: number,
    chats: FollowUpCandidate[],
    candidatesForWorkflow: number,
    dryRun: boolean,
    log: FastifyBaseLogger,
  ): Promise<{ sent: number; errors: number; processed: number; deferred: number }> {
    const wfLog = log.child({ workflow_id: workflowId });
    wfLog.info(
      { count: chats.length, candidates: candidatesForWorkflow, dryRun },
      'follow-up: cola del workflow iniciada',
    );

    let sent = 0;
    let errors = 0;

    for (let i = 0; i < chats.length; i++) {
      if (i > 0 && !dryRun) {
        const delay = randomDelayMs();
        wfLog.info(
          { delay_ms: delay, remaining: chats.length - i },
          'follow-up: esperando antes del próximo envío',
        );
        await sleep(delay);
      }

      try {
        await this.runForChat(chats[i], wfLog);
        sent++;
      } catch (e) {
        errors++;
        wfLog.error({ err: e, chat_id: chats[i].chat_id }, 'runForChat exception');
      }
    }

    const processed = chats.length;
    const deferred = candidatesForWorkflow - processed;

    // Persistir métricas del run para auditoría/dashboards.
    const { error: logError } = await supabase.from('unipile_follow_up_log').insert({
      workflow_id: workflowId,
      candidates: candidatesForWorkflow,
      processed,
      deferred,
      sent,
      errors,
      dry_run: dryRun,
    });
    if (logError) {
      wfLog.error({ err: logError }, 'follow-up: insert en unipile_follow_up_log falló');
    }

    wfLog.info({ sent, errors, processed, deferred }, 'follow-up: cola del workflow terminada');
    return { sent, errors, processed, deferred };
  },

  async runBatch(
    log: FastifyBaseLogger,
    options?: { limit?: number },
  ): Promise<{
    candidates: number;
    processed: number;
    deferred: number;
    sent: number;
    errors: number;
    workflows: number;
  }> {
    const all = await this.listCandidates(log);
    const candidates = options?.limit ? all.slice(0, options.limit) : all;

    log.info(
      { total: all.length, processing: candidates.length, dryRun: isDryRun() },
      'follow-up: candidatos encontrados',
    );

    if (candidates.length === 0) {
      return { candidates: 0, processed: 0, deferred: 0, sent: 0, errors: 0, workflows: 0 };
    }

    // Agrupar por workflow_id — cada grupo es una cola independiente.
    const byWorkflow = new Map<number, FollowUpCandidate[]>();
    for (const c of candidates) {
      const arr = byWorkflow.get(c.workflow_id) ?? [];
      arr.push(c);
      byWorkflow.set(c.workflow_id, arr);
    }

    // Cap por workflow para evitar baneos en cuentas con mucha actividad.
    // El sobrante queda elegible para el próximo cron (follow_up_sent_at sigue null).
    // Guardamos el count original para pasarlo al log de la corrida.
    const maxPerWorkflow = getMaxPerWorkflow();
    const originalCounts = new Map<number, number>();
    let totalAfterCap = 0;
    for (const [wfId, chats] of byWorkflow) {
      originalCounts.set(wfId, chats.length);
      if (chats.length > maxPerWorkflow) {
        log.warn(
          { workflow_id: wfId, total: chats.length, processing: maxPerWorkflow, deferred: chats.length - maxPerWorkflow },
          'follow-up: workflow excede el cap, sobrante se procesa mañana',
        );
        byWorkflow.set(wfId, chats.slice(0, maxPerWorkflow));
      }
      totalAfterCap += byWorkflow.get(wfId)!.length;
    }

    log.info(
      { workflows: byWorkflow.size, total_after_cap: totalAfterCap, max_per_workflow: maxPerWorkflow },
      'follow-up: candidatos agrupados por workflow',
    );

    const dryRun = isDryRun();

    // Cada cola corre en paralelo, dentro de cada una se respeta el sleep secuencial.
    const results = await Promise.allSettled(
      Array.from(byWorkflow.entries()).map(([wfId, chats]) =>
        this.processWorkflowQueue(wfId, chats, originalCounts.get(wfId) ?? chats.length, dryRun, log),
      ),
    );

    let sent = 0;
    let errors = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        sent += r.value.sent;
        errors += r.value.errors;
      } else {
        log.error({ err: r.reason }, 'workflow queue exception');
        errors++;
      }
    }

    const deferred = candidates.length - totalAfterCap;
    log.info(
      {
        candidates: candidates.length,
        processed: totalAfterCap,
        deferred,
        workflows: byWorkflow.size,
        sent,
        errors,
      },
      'follow-up: batch terminado',
    );
    return {
      candidates: candidates.length,
      processed: totalAfterCap,
      deferred,
      sent,
      errors,
      workflows: byWorkflow.size,
    };
  },
};
