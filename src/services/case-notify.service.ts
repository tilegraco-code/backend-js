// Aviso proactivo: cuando la revisión de un documento termina después de que el agente ya
// respondió, se dispara un turno para contarle el resultado al cliente sin esperar a que escriba.
// Ver docs/documentos-y-casos-plan.md, "Cuando el worker termina después del turno".
//
// El pedido lo deja chat-documents.service en `chat_cases.notify_requested_at`. Acá se decide
// si todavía corresponde y se despacha por el mismo camino que un mensaje entrante.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { dispatchToRuntime } from './agent-runtime.service';
import type { CaseEvaluation } from './case-evaluator';

/** Se espera un poco antes de avisar: si llegan cinco fotos seguidas, sale un solo mensaje. */
const GROUP_MS = 20_000;
/** Como máximo un aviso por chat en este intervalo. */
const MIN_INTERVAL_MS = 60_000;
/** Si quedan documentos en revisión se espera a que terminen, pero no para siempre. */
const MAX_WAIT_PROCESSING_MS = 5 * 60_000;
/** Ventana de WhatsApp para escribir sin plantilla. */
const WHATSAPP_WINDOW_MS = 24 * 3600_000;

/**
 * Lo que recibe el agente como mensaje del turno. El estado del caso viaja aparte, en el
 * contexto, como en cualquier turno.
 */
export const NOTICE =
  '[Aviso interno del sistema, no lo escribió el cliente] Terminó la revisión de los documentos ' +
  'que mandó el cliente. Mirá el estado del caso y contale el resultado en un mensaje breve: qué ' +
  'tiene que reenviar o mandar, o que ya está todo completo. No repitas lo que ya le dijiste.';

type PendingNotify = {
  id: number;
  chat_id: string;
  number: string;
  status: string;
  evaluation: CaseEvaluation | null;
  notify_requested_at: string;
  notified_at: string | null;
};

export type NotifySkipReason =
  | 'wait_interval'
  | 'wait_processing'
  | 'claimed_elsewhere'
  | 'no_chat'
  | 'human_takeover'
  | 'already_answered'
  | 'window_closed';

export const caseNotifyService = {
  async runBatch(log: FastifyBaseLogger, limit = 10): Promise<{ sent: number; skipped: number }> {
    const { data, error } = await supabase
      .from('chat_cases')
      .select('id, chat_id, number, status, evaluation, notify_requested_at, notified_at')
      .not('notify_requested_at', 'is', null)
      .lte('notify_requested_at', new Date(Date.now() - GROUP_MS).toISOString())
      .order('notify_requested_at', { ascending: true })
      .limit(limit);
    if (error) throw error;

    let sent = 0;
    let skipped = 0;
    for (const row of (data ?? []) as PendingNotify[]) {
      const result = await this.notifyOne(row, log);
      if (result === 'sent') sent += 1;
      else if (!result.startsWith('wait_')) skipped += 1;
    }
    return { sent, skipped };
  },

  async notifyOne(row: PendingNotify, log: FastifyBaseLogger): Promise<'sent' | NotifySkipReason> {
    const caseLog = log.child({ caseId: row.id, number: row.number, chatId: row.chat_id });
    const now = Date.now();
    const requestedAt = new Date(row.notify_requested_at).getTime();

    // Esperas: el pedido sigue en pie para la próxima pasada.
    if (row.notified_at && now - new Date(row.notified_at).getTime() < MIN_INTERVAL_MS) return 'wait_interval';
    if ((row.evaluation?.processing ?? 0) > 0 && now - requestedAt < MAX_WAIT_PROCESSING_MS) return 'wait_processing';

    // Claim: consume el pedido. Si otra pasada lo tomó, no coincide y no se avisa dos veces.
    const { data: claimed } = await supabase
      .from('chat_cases')
      .update({ notify_requested_at: null })
      .eq('id', row.id)
      .eq('notify_requested_at', row.notify_requested_at)
      .select('id');
    if (!claimed?.length) return 'claimed_elsewhere';

    const skip = (reason: NotifySkipReason) => {
      caseLog.info({ reason }, 'case-notify: aviso descartado');
      return reason;
    };

    if (row.status !== 'open' && row.status !== 'complete') return skip('no_chat');

    const { data: chat } = await supabase
      .from('unipile_chats')
      .select('state, workflow_id, contact_name, provider')
      .eq('chat_id', row.chat_id)
      .maybeSingle();
    if (!chat?.workflow_id) return skip('no_chat');
    // Un operador tomó la conversación: el agente no habla.
    if (chat.state !== 'ia') return skip('human_takeover');

    const [{ data: answered }, { data: lastIncoming }] = await Promise.all([
      // Si el agente ya respondió después de que llegó el resultado, esa respuesta lo vio.
      supabase
        .from('unipile_messages')
        .select('id')
        .eq('chat_id', row.chat_id)
        .eq('direction', 'outgoing')
        .gt('created_at', row.notify_requested_at)
        .limit(1),
      supabase
        .from('unipile_messages')
        .select('created_at')
        .eq('chat_id', row.chat_id)
        .eq('direction', 'incoming')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    if (answered?.length) return skip('already_answered');

    const provider = String(chat.provider ?? '').toUpperCase();
    if (
      (provider === 'WHATSAPP' || provider === 'INSTAGRAM') &&
      (!lastIncoming?.created_at || now - new Date(lastIncoming.created_at as string).getTime() > WHATSAPP_WINDOW_MS)
    ) {
      return skip('window_closed');
    }

    await supabase.from('chat_cases').update({ notified_at: new Date().toISOString() }).eq('id', row.id);
    caseLog.info('case-notify: disparando aviso');
    await dispatchToRuntime(
      { chat_id: row.chat_id, nombre: (chat.contact_name as string | null) ?? 'Cliente', question: NOTICE },
      chat.workflow_id as number,
      channelFor(provider),
      caseLog,
    );
    return 'sent';
  },
};

function channelFor(provider: string): string {
  switch (provider) {
    case 'MERCADOLIBRE':
      return 'mercadolibre';
    case 'WEB':
      return 'web';
    case 'TEST':
      return 'test';
    default:
      return 'whatsapp';
  }
}
