import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { forwardToN8n, type N8nForwardPayload } from './n8n-forward';
import { evolutionApiService } from './evolution-api.service';
import {
  describeForInbox,
  ingestAttachments,
  kindFromMime,
  signAttachments,
  type PendingAttachment,
} from './attachment-ingest.service';
import type {
  EvolutionConnectionUpdateData,
  EvolutionMediaMessage,
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

/**
 * El archivo que trae el mensaje, si trae alguno.
 *
 * WhatsApp manda UNO por mensaje, así que devuelve uno solo. Los stickers se dejan
 * afuera a propósito: son ruido, no una consulta, y describir cada uno costaría tokens
 * por nada.
 */
function extractMedia(msg: EvolutionMessageContent | null | undefined): EvolutionMediaMessage | null {
  if (!msg) return null;
  return (
    msg.imageMessage ??
    msg.documentMessage ??
    msg.documentWithCaptionMessage?.message?.documentMessage ??
    msg.audioMessage ??
    msg.videoMessage ??
    null
  );
}

/**
 * Lo que hay que hacer con el archivo DESPUÉS de contestarle a Evolution. Igual que en
 * Unipile: bajar varios MB no puede colgarse del ACK del webhook.
 */
type PendingIngest = {
  clientId: number;
  chatId: string;
  messageId: string;
  instance: string;
  attachments: PendingAttachment[];
};

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

type ResolvedInbox = {
  id: number;
  client_id: number;
  workflow_id: number | null;
  suspended: boolean | null;
};

async function resolveInbox(instance: string): Promise<ResolvedInbox | null> {
  const { data } = await supabase
    .from('unipile_inboxes')
    .select('id, client_id, workflow_id, suspended')
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
  ): Promise<
    ProcessResult & {
      forward?: { workflowId: number; payload: N8nForwardPayload };
      ingest?: PendingIngest;
    }
  > {
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
    const media = extractMedia(data.message);

    // Un mensaje sin texto pero con archivo es un mensaje válido: una foto sin caption es
    // lo más común en WhatsApp. Antes se descartaba acá y se perdía entero.
    if (!text && !media) {
      return { ok: true, skipped: 'no_text' };
    }

    // Evolution sólo avisa que hay media; los bytes se piden después por el id del mensaje.
    const pendingAttachments: PendingAttachment[] = media
      ? [
          {
            providerId: data.key.id,
            mime: media.mimetype || 'application/octet-stream',
            name: media.fileName ?? null,
          },
        ]
      : [];

    // Lo que ve un humano en la bandeja.
    const contentText =
      text ||
      describeForInbox(
        pendingAttachments.map((a) => ({ kind: kindFromMime(a.mime), name: a.name })),
      );

    const inbox = await resolveInbox(instance);
    if (!inbox) {
      return { ok: false, status: 404, error: 'Unknown instance' };
    }
    // Canal suspendido (trial vencido / plan impago): no se persiste ni se
    // responde nada. La instancia debería estar borrada en Evolution, pero un
    // webhook tardío no puede reactivar el servicio por la ventana de atrás.
    if (inbox.suspended === true) {
      log.warn({ instance, inbox_id: inbox.id }, 'evolution: mensaje en inbox suspendido — ignorado');
      return { ok: true, skipped: 'inbox_suspended' };
    }

    const event = (payload.event ?? '').toLowerCase();
    const isOwn = data.key.fromMe === true || event === 'send.message';
    const direction = isOwn ? 'outgoing' : 'incoming';
    // El remoteJid (numero@s.whatsapp.net) solo es unico dentro de una instancia.
    // Prefijamos con la instancia para tener un chat_id unico global (dos clientes
    // o dos lineas hablando con el mismo numero no colisionan). El numero crudo
    // queda en contact_handle, asi que el saliente no necesita parsear el chat_id.
    const remoteJid = data.key.remoteJid;
    const chatId = `${instance}:${remoteJid}`;
    const messageId = data.key.id;
    const msgAt = parseTimestamp(data.messageTimestamp);
    const contactHandle = jidToHandle(remoteJid);
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
      content: contentText,
      direction,
      sender_name: isOwn ? null : contactName,
      created_at: msgAt,
    });

    const isNewMessage = !msgError;

    if (msgError && msgError.code !== '23505') {
      log.error({ err: msgError }, 'message insert error');
      return { ok: false, status: 500, error: 'DB error (message)' };
    }

    // El archivo se baja y se sube en background, ya con el mensaje persistido. Se hace
    // aunque el chat lo atienda un humano: la bandeja tiene que mostrarlo igual.
    const ingest: PendingIngest | undefined =
      isNewMessage && pendingAttachments.length > 0
        ? { clientId, chatId, messageId, instance, attachments: pendingAttachments }
        : undefined;

    // Decidir forward a n8n (sin ejecutarlo — eso queda en background del caller).
    if (!isOwn && isNewMessage) {
      const { data: chat } = await supabase
        .from('unipile_chats')
        .select('state, workflow_id')
        .eq('chat_id', chatId)
        .single();

      if (chat?.state === 'ia' && chat.workflow_id) {
        return {
          ok: true,
          ingest,
          forward: {
            workflowId: chat.workflow_id,
            payload: {
              chat_id: chatId,
              nombre: contactName,
              question: contentText,
            },
          },
        };
      }
    }

    return { ok: true, ingest };
  },

  /**
   * Todo lo que corre DESPUÉS del ACK del webhook: bajar el archivo, guardarlo y recién
   * ahí ejecutar el turno del agente.
   *
   * El orden importa: si el forward saliera en paralelo con la ingesta, el agente
   * respondería sobre un mensaje cuyo archivo todavía no existe. Que la ingesta falle no
   * cancela el turno; el agente contesta sin el adjunto.
   */
  async runBackground(
    result: { forward?: { workflowId: number; payload: N8nForwardPayload }; ingest?: PendingIngest },
    channel: string,
    log: FastifyBaseLogger,
    dispatch: (
      payload: N8nForwardPayload,
      workflowId: number,
      channel: string,
      log: FastifyBaseLogger,
    ) => Promise<void>,
  ): Promise<void> {
    if (result.ingest) {
      const { clientId, chatId, messageId, instance, attachments } = result.ingest;

      const stored = await ingestAttachments(
        {
          clientId,
          chatId,
          messageId,
          attachments,
          fetchBytes: async () => {
            const media = await evolutionApiService.getMediaBase64(instance, messageId);
            return { bytes: Buffer.from(media.base64, 'base64'), mime: media.mimetype };
          },
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
    // Suspendido: el estado lo fija el corte de ciclo de vida, no el proveedor.
    if (inbox.suspended === true) {
      return { ok: true, skipped: 'inbox_suspended' };
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
