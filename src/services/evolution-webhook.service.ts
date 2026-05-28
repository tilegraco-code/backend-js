import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { forwardToN8n } from './n8n-forward';
import type {
  EvolutionConnectionUpdateData,
  EvolutionMessageContent,
  EvolutionMessageUpsertData,
  EvolutionWebhookPayload,
} from '../types/evolution';
import type { UnipileAccountStatus } from '../types/unipile';

type ProcessResult =
  | { ok: true; skipped?: string }
  | { ok: false; status: number; error: string };

// ---------- HELPERS ----------

function extractText(msg: EvolutionMessageContent | null | undefined): string {
  if (!msg) return '';
  return (
    msg.conversation ??
    msg.extendedTextMessage?.text ??
    msg.imageMessage?.caption ??
    msg.videoMessage?.caption ??
    msg.documentMessage?.caption ??
    msg.buttonsResponseMessage?.selectedDisplayText ??
    msg.listResponseMessage?.title ??
    ''
  );
}

function parseTimestamp(ts: number | string | undefined): string {
  if (!ts) return new Date().toISOString();
  const n = typeof ts === 'string' ? Number.parseInt(ts, 10) : ts;
  if (!Number.isFinite(n)) return new Date().toISOString();
  // Evolution manda epoch en segundos.
  return new Date(n * 1000).toISOString();
}

function jidToHandle(jid: string | undefined | null): string | null {
  if (!jid) return null;
  return jid.split('@')[0] ?? null;
}

// ---------- RESOLUCIÓN DE INBOX ----------

type ResolvedInbox = { id: number; client_id: number; workflow_id: number | null };

async function resolveInbox(instance: string): Promise<ResolvedInbox | null> {
  const { data } = await supabase
    .from('unipile_inboxes')
    .select('id, client_id, workflow_id')
    .eq('evolution_instance_name', instance)
    .eq('source', 'evolution')
    .maybeSingle();
  return data ?? null;
}

export const evolutionWebhookService = {
  /**
   * Procesa messages.upsert / send.message: upsert del chat, insert del mensaje
   * y decisión de forward a n8n (sin ejecutarlo — eso queda en background del caller).
   */
  async processMessage(
    payload: EvolutionWebhookPayload,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult & { forward?: { workflowId: number } }> {
    const instance = payload.instance;
    if (!instance) {
      return { ok: true, skipped: 'no_instance' };
    }

    const data = payload.data as EvolutionMessageUpsertData | undefined;
    if (!data?.key?.remoteJid || !data.key.id) {
      return { ok: true, skipped: 'no_key' };
    }

    // Ignorar mensajes de grupos por ahora.
    if (data.key.remoteJid.endsWith('@g.us')) {
      return { ok: true, skipped: 'group' };
    }

    const text = extractText(data.message);
    if (!text) {
      return { ok: true, skipped: 'no_text' };
    }

    const inbox = await resolveInbox(instance);
    if (!inbox) {
      return { ok: false, status: 404, error: 'Unknown instance' };
    }

    const event = (payload.event ?? '').toLowerCase();
    const isOwn = data.key.fromMe === true || event === 'send.message';
    const direction = isOwn ? 'outgoing' : 'incoming';
    const chatId = data.key.remoteJid;
    const messageId = data.key.id;
    const msgAt = parseTimestamp(data.messageTimestamp);
    const contactHandle = jidToHandle(chatId);
    const contactName = data.pushName?.trim() || contactHandle || 'Usuario Desconocido';
    const workflowId: number | null = inbox.workflow_id ?? null;
    const clientId = inbox.client_id;

    log.info(
      { instance, event, chatId, fromMe: data.key.fromMe, isOwn },
      'evolution webhook procesando mensaje',
    );

    // Upsert del chat: INSERT, y si 23505 (duplicado) UPDATE preview.
    const { error: insertError } = await supabase.from('unipile_chats').insert({
      client_id: clientId,
      chat_id: chatId,
      account_id: instance,
      workflow_id: workflowId,
      state: 'ia',
      provider: 'WHATSAPP',
      contact_id: null,
      contact_name: contactName,
      contact_handle: contactHandle,
      contact_avatar_url: null,
      last_message_preview: text.slice(0, 120),
      last_message_at: msgAt,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        const updatePayload: Record<string, unknown> = {
          last_message_preview: text.slice(0, 120),
          last_message_at: msgAt,
          updated_at: new Date().toISOString(),
        };
        if (workflowId !== null) updatePayload.workflow_id = workflowId;

        // El entrante es la fuente autoritativa del contacto.
        if (!isOwn) {
          updatePayload.contact_name = contactName;
          updatePayload.contact_handle = contactHandle;
        }

        await supabase.from('unipile_chats').update(updatePayload).eq('chat_id', chatId);
      } else {
        log.error({ err: insertError }, 'chat insert error');
        return { ok: false, status: 500, error: 'DB error (chat)' };
      }
    }

    // Unread solo para entrantes.
    if (!isOwn) {
      await supabase.rpc('increment_unipile_unread', { p_chat_id: chatId });
    }

    // Insert mensaje — detecta duplicados via 23505.
    const { error: msgError } = await supabase.from('unipile_messages').insert({
      chat_id: chatId,
      client_id: clientId,
      message_id: messageId,
      content: text,
      direction,
      sender_name: isOwn ? null : contactName,
      created_at: msgAt,
    });

    const isNewMessage = !msgError;

    if (msgError && msgError.code !== '23505') {
      log.error({ err: msgError }, 'message insert error');
      return { ok: false, status: 500, error: 'DB error (message)' };
    }

    // Decidir forward a n8n (sin ejecutarlo — eso queda en background del caller).
    if (!isOwn && isNewMessage) {
      const { data: chat } = await supabase
        .from('unipile_chats')
        .select('state, workflow_id')
        .eq('chat_id', chatId)
        .single();

      if (chat?.state === 'ia' && chat.workflow_id) {
        return { ok: true, forward: { workflowId: chat.workflow_id } };
      }
    }

    return { ok: true };
  },

  /**
   * Dispara el forward a n8n. Pensado para llamarse via setImmediate post-reply.
   */
  forwardToN8n,

  /**
   * Procesa connection.update: mapea el estado de la sesión a account_status.
   */
  async processConnectionUpdate(
    payload: EvolutionWebhookPayload,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult & { account_status?: UnipileAccountStatus }> {
    const instance = payload.instance;
    if (!instance) {
      return { ok: true, skipped: 'no_instance' };
    }

    const inbox = await resolveInbox(instance);
    if (!inbox) {
      return { ok: false, status: 404, error: 'Unknown instance' };
    }

    const data = payload.data as EvolutionConnectionUpdateData | undefined;
    const state = data?.state;
    let accountStatus: UnipileAccountStatus | null = null;
    if (state === 'open') accountStatus = 'connected';
    else if (state === 'connecting') accountStatus = 'connecting';
    else if (state === 'close') accountStatus = 'disconnected';

    if (!accountStatus) {
      return { ok: true, skipped: `state:${state ?? 'unknown'}` };
    }

    log.info({ instance, state, accountStatus }, 'evolution connection.update');

    const { error } = await supabase
      .from('unipile_inboxes')
      .update({
        account_status: accountStatus,
        ...(accountStatus === 'connected' ? { status: 'inactive' } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('id', inbox.id);

    if (error) {
      log.error({ err: error }, 'connection.update DB error');
      return { ok: false, status: 500, error: 'DB error' };
    }

    return { ok: true, account_status: accountStatus };
  },
};
