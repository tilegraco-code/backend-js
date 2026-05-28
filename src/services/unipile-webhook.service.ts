import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { forwardToN8n, type N8nForwardPayload } from './n8n-forward';
import type {
  UnipileAccountStatus,
  UnipileAccountStatusPayload,
  UnipileWebhookPayload,
} from '../types/unipile';

type ProcessResult =
  | { ok: true; skipped?: string }
  | { ok: false; status: number; error: string };

function resolveAccountStatus(message: string): UnipileAccountStatus | null {
  switch (message.toUpperCase()) {
    case 'CREATION_SUCCESS':
    case 'RECONNECTED':
    case 'SYNC_SUCCESS':
    case 'STATUS_OK':
      return 'connected';
    case 'DELETION':
    case 'STOPPED':
      return 'disconnected';
    case 'CREATION_FAIL':
    case 'ERROR':
    case 'CREDENTIALS':
    case 'PERMISSIONS':
      return 'error';
    default:
      return null;
  }
}

export const unipileWebhookService = {
  /**
   * Procesa el webhook principal de Unipile (message_received).
   * El n8n forward se dispara en background (caller decide cuándo).
   */
  async processMessage(
    payload: UnipileWebhookPayload,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult & { forward?: { workflowId: number; payload: N8nForwardPayload } }> {
    if (payload.event !== 'message_received') {
      return { ok: true, skipped: payload.event };
    }

    if (!payload.message) {
      return { ok: true, skipped: 'no_message_content' };
    }

    const { account_id, account_type, chat_id, message_id, message, timestamp, sender } = payload;

    // Resolver client_id real desde unipile_inboxes.account_id (no del path)
    const { data: inbox } = await supabase
      .from('unipile_inboxes')
      .select('client_id, workflow_id')
      .eq('account_id', account_id)
      .maybeSingle();

    if (!inbox) {
      return { ok: false, status: 404, error: 'Unknown account' };
    }

    const clientId = inbox.client_id;
    const ownUserId = payload.account_info?.user_id ?? null;
    const isOwn =
      payload.is_sender === true ||
      (ownUserId != null && ownUserId === sender?.attendee_provider_id);

    log.info(
      {
        account_id,
        account_type,
        is_sender: payload.is_sender,
        ownUserId,
        senderProviderId: sender?.attendee_provider_id,
        isOwn,
      },
      'unipile webhook procesando mensaje',
    );

    const direction = isOwn ? 'outgoing' : 'incoming';
    const msgAt = timestamp;

    // Resolver contacto real (NO la cuenta conectada)
    const contact = !isOwn
      ? sender
      : (payload.attendees ?? []).find(
          (a) => a.attendee_provider_id && a.attendee_provider_id !== ownUserId,
        ) ?? null;

    const workflowId: number | null = inbox.workflow_id ?? null;

    // Upsert del chat: INSERT, y si 23505 (duplicado) UPDATE preview
    const { error: insertError } = await supabase.from('unipile_chats').insert({
      client_id: clientId,
      chat_id,
      account_id,
      workflow_id: workflowId,
      state: 'ia',
      provider: account_type,
      contact_id: contact?.attendee_id ?? null,
      contact_name: contact?.attendee_name ?? 'Usuario Desconocido',
      contact_handle: contact?.attendee_provider_id ?? null,
      contact_avatar_url: contact?.attendee_profile_url ?? null,
      last_message_preview: message.slice(0, 120),
      last_message_at: msgAt,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        const updatePayload: Record<string, unknown> = {
          last_message_preview: message.slice(0, 120),
          last_message_at: msgAt,
          updated_at: new Date().toISOString(),
        };
        if (workflowId !== null) updatePayload.workflow_id = workflowId;

        // El entrante es la fuente autoritativa del contacto: corrige el
        // placeholder cuando el contacto responde.
        if (!isOwn) {
          updatePayload.contact_name = sender.attendee_name;
          updatePayload.contact_id = sender.attendee_id;
          updatePayload.contact_handle = sender.attendee_provider_id;
          updatePayload.contact_avatar_url = sender.attendee_profile_url;
        }

        await supabase.from('unipile_chats').update(updatePayload).eq('chat_id', chat_id);
      } else {
        log.error({ err: insertError }, 'chat insert error');
        return { ok: false, status: 500, error: 'DB error (chat)' };
      }
    }

    // Unread solo para entrantes
    if (!isOwn) {
      await supabase.rpc('increment_unipile_unread', { p_chat_id: chat_id });
    }

    // Insert mensaje — detecta duplicados via 23505
    const { error: msgError } = await supabase.from('unipile_messages').insert({
      chat_id,
      client_id: clientId,
      message_id,
      content: message,
      direction,
      sender_name: isOwn ? null : sender.attendee_name,
      created_at: msgAt,
    });

    const isNewMessage = !msgError;

    if (msgError && msgError.code !== '23505') {
      log.error({ err: msgError }, 'message insert error');
      return { ok: false, status: 500, error: 'DB error (message)' };
    }

    // Decidir forward a n8n (sin ejecutarlo — eso queda en background del caller)
    if (!isOwn && isNewMessage) {
      const { data: chat } = await supabase
        .from('unipile_chats')
        .select('state, workflow_id')
        .eq('chat_id', chat_id)
        .single();

      if (chat?.state === 'ia' && chat.workflow_id) {
        return {
          ok: true,
          forward: {
            workflowId: chat.workflow_id,
            payload: {
              chat_id,
              nombre: sender.attendee_name,
              question: message,
            },
          },
        };
      }
    }

    return { ok: true };
  },

  /**
   * Dispara el forward a n8n. Pensado para llamarse via setImmediate post-reply.
   */
  forwardToN8n,

  /**
   * Procesa el webhook de status de cuenta (account_status_ok, error, etc.).
   */
  async processAccountStatus(
    payload: UnipileAccountStatusPayload,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult & { message?: string; account_status?: UnipileAccountStatus }> {
    const status = payload?.AccountStatus;
    if (!status?.account_id || !status?.message) {
      log.warn({ payload }, 'unexpected payload structure');
      return { ok: false, status: 400, error: 'Invalid payload structure' };
    }

    const { account_id, message } = status;
    log.info({ account_id, message }, 'unipile accounts webhook');

    const accountStatus = resolveAccountStatus(message);
    if (!accountStatus) {
      return { ok: true, skipped: message };
    }

    const { error } = await supabase
      .from('unipile_inboxes')
      .update({ account_status: accountStatus, updated_at: new Date().toISOString() })
      .eq('account_id', account_id);

    if (error) {
      log.error({ err: error }, 'accounts webhook DB update error');
      return { ok: false, status: 500, error: 'DB error' };
    }

    return { ok: true, message, account_status: accountStatus };
  },

  /**
   * Callback de hosted auth: empareja un inbox pending (o reconexión) con account_id.
   * El token es el connection_token guardado en la fila al generar el link.
   */
  async processAccountConnected(
    clientId: number,
    token: string,
    body: { account_id?: string; account_type?: string; type?: string },
    log: FastifyBaseLogger,
  ): Promise<ProcessResult> {
    if (!token) {
      return { ok: false, status: 400, error: 'Missing token' };
    }

    const accountId = body.account_id;
    const accountType = body.account_type ?? body.type;
    if (!accountId) {
      return { ok: false, status: 400, error: 'Missing account_id' };
    }

    const { data: inbox, error: findError } = await supabase
      .from('unipile_inboxes')
      .select('id, client_id, account_id')
      .eq('connection_token', token)
      .eq('client_id', clientId)
      .maybeSingle();

    if (findError || !inbox) {
      log.error({ token, err: findError }, 'inbox not found');
      return { ok: false, status: 404, error: 'Inbox not found' };
    }

    const isReconnect = !!inbox.account_id;
    const updatePayload = isReconnect
      ? {
          account_status: 'connected' as const,
          connection_token: null,
          updated_at: new Date().toISOString(),
        }
      : {
          account_id: accountId,
          provider: accountType ?? null,
          status: 'inactive' as const,
          account_status: 'connected' as const,
          connection_token: null,
          updated_at: new Date().toISOString(),
        };

    const { error: updateError } = await supabase
      .from('unipile_inboxes')
      .update(updatePayload)
      .eq('id', inbox.id);

    if (updateError) {
      log.error({ err: updateError }, 'account-connected update error');
      return { ok: false, status: 500, error: 'DB error' };
    }

    return { ok: true };
  },
};
