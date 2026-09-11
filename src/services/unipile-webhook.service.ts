import { randomUUID } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { getOwnerEmail } from '../lib/owner-email';
import { sendCapiEvent } from './meta-capi.service';
import { forwardToN8n, type N8nForwardPayload } from './n8n-forward';
import { unipileApiService } from './unipile-api.service';
import {
  describeForInbox,
  ingestAttachments,
  kindFromMime,
  signAttachments,
  type PendingAttachment,
} from './attachment-ingest.service';
import type {
  UnipileAccountStatus,
  UnipileAccountStatusPayload,
  UnipileWebhookPayload,
} from '../types/unipile';

type ProcessResult =
  | { ok: true; skipped?: string }
  | { ok: false; status: number; error: string };

/**
 * Lo que hay que hacer con los adjuntos DESPUÉS de contestarle a Unipile: bajarlos
 * del proveedor y subirlos a Storage. Nunca dentro del handler — mover varios MB no
 * puede colgarse del ACK del webhook.
 */
type PendingIngest = {
  clientId: number;
  chatId: string;
  messageId: string;
  attachments: PendingAttachment[];
};

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
  ): Promise<
    ProcessResult & {
      forward?: { workflowId: number; payload: N8nForwardPayload };
      ingest?: PendingIngest;
    }
  > {
    if (payload.event !== 'message_received') {
      return { ok: true, skipped: payload.event };
    }

    const { account_id, account_type, chat_id, message_id, message, timestamp, sender } = payload;

    // Adjuntos anunciados por el webhook. Los bytes NO vienen acá: se bajan después
    // por la API, ya descifrados (ver unipileApiService.getMessageAttachment).
    const pendingAttachments: PendingAttachment[] = (payload.attachments ?? [])
      .filter((a) => a.id && !a.unavailable)
      .map((a) => ({
        providerId: a.id as string,
        mime: a.mimetype || 'application/octet-stream',
        name: a.file_name ?? null,
      }));

    // Un mensaje sin texto pero con adjunto es un mensaje válido: una foto sin
    // caption es lo más común del mundo en WhatsApp. Antes se descartaba acá y se
    // perdía entero, ni siquiera llegaba a la bandeja.
    if (!message && pendingAttachments.length === 0) {
      return { ok: true, skipped: 'no_message_content' };
    }

    // Lo que ve un humano en la bandeja. El texto propio manda; si no hay, describe
    // el adjunto. El contenido del archivo NO va acá: lo extrae el runtime en el turno.
    const contentText =
      message ||
      describeForInbox(
        pendingAttachments.map((a) => ({ kind: kindFromMime(a.mime), name: a.name })),
      );

    // Resolver client_id real desde unipile_inboxes.account_id (no del path)
    const { data: inbox } = await supabase
      .from('unipile_inboxes')
      .select('client_id, workflow_id, suspended')
      .eq('account_id', account_id)
      .maybeSingle();

    if (!inbox) {
      return { ok: false, status: 404, error: 'Unknown account' };
    }

    // Canal suspendido (trial vencido / plan impago): no se persiste ni se
    // responde nada, aunque la cuenta siga viva del lado de Unipile.
    if (inbox.suspended === true) {
      log.warn({ account_id }, 'unipile: mensaje en inbox suspendido — ignorado');
      return { ok: true, skipped: 'inbox_suspended' };
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
      last_message_preview: contentText.slice(0, 120),
      last_message_at: msgAt,
    });

    if (insertError) {
      if (insertError.code === '23505') {
        const updatePayload: Record<string, unknown> = {
          last_message_preview: contentText.slice(0, 120),
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
      content: contentText,
      direction,
      sender_name: isOwn ? null : sender.attendee_name,
      created_at: msgAt,
    });

    const isNewMessage = !msgError;

    if (msgError && msgError.code !== '23505') {
      log.error({ err: msgError }, 'message insert error');
      return { ok: false, status: 500, error: 'DB error (message)' };
    }

    // Los adjuntos se bajan y se suben en background, ya con el mensaje persistido.
    // Se hace aunque el chat esté en manos de un humano o el mensaje sea saliente:
    // la bandeja tiene que mostrar el archivo igual, no solo cuando contesta la IA.
    const ingest: PendingIngest | undefined =
      isNewMessage && pendingAttachments.length > 0
        ? { clientId, chatId: chat_id, messageId: message_id, attachments: pendingAttachments }
        : undefined;

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
          ingest,
          forward: {
            workflowId: chat.workflow_id,
            payload: {
              chat_id,
              nombre: sender.attendee_name,
              // Con adjunto y sin caption, `question` queda como el placeholder
              // (`[imagen]`). Es lo que también se guarda en agentuse, así que la
              // fila sigue siendo legible en vez de quedar vacía.
              question: contentText,
            },
          },
        };
      }
    }

    return { ok: true, ingest };
  },

  /**
   * Todo lo que corre DESPUÉS del ACK del webhook: bajar los adjuntos, guardarlos y
   * recién ahí ejecutar el turno del agente.
   *
   * El orden importa. El agente tiene que recibir las URLs firmadas en el mismo
   * turno en que llegó la imagen; si el forward saliera en paralelo con la ingesta,
   * llegaría con las manos vacías y respondería sobre un mensaje que no vio.
   *
   * Que la ingesta falle no cancela el turno: el agente contesta igual, sin el
   * adjunto. Una respuesta parcial es mejor que el silencio.
   */
  async runBackground(
    result: { forward?: { workflowId: number; payload: N8nForwardPayload }; ingest?: PendingIngest },
    channel: string,
    log: FastifyBaseLogger,
    dispatch: (payload: N8nForwardPayload, workflowId: number, channel: string, log: FastifyBaseLogger) => Promise<void>,
  ): Promise<void> {
    if (result.ingest) {
      const { clientId, chatId, messageId, attachments } = result.ingest;

      const stored = await ingestAttachments(
        {
          clientId,
          chatId,
          messageId,
          attachments,
          fetchBytes: (a) => unipileApiService.getMessageAttachment(messageId, a.providerId),
        },
        log,
      );

      if (stored.length > 0) {
        const { error } = await supabase
          .from('unipile_messages')
          .update({ attachments: stored })
          .eq('message_id', messageId);
        if (error) log.error({ err: error, messageId }, 'adjuntos: update del mensaje falló');

        if (result.forward) {
          result.forward.payload.attachments = await signAttachments(stored, log);
        }
      }
    }

    if (result.forward) {
      await dispatch(result.forward.payload, result.forward.workflowId, channel, log);
    }
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

    // Activación: primer inbox conectado (no reconexión). Evento a Meta CAPI en
    // background — nunca bloquea ni rompe el callback de hosted auth.
    if (!isReconnect) {
      void (async () => {
        const email = await getOwnerEmail(clientId, log);
        await sendCapiEvent(
          {
            eventName: 'inbox_connected',
            eventId: randomUUID(),
            actionSource: 'system_generated',
            customData: { channel: accountType ?? undefined },
            user: { email: email ?? undefined, externalId: clientId },
          },
          log,
        );
      })().catch((err) => log.error({ err, clientId }, 'inbox_connected CAPI falló'));
    }

    return { ok: true };
  },
};
