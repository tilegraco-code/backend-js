import { randomUUID } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { evolutionApiService } from './evolution-api.service';
import { unipileApiService } from './unipile-api.service';

type SendResult =
  | { ok: true; message_id: string }
  | { ok: false; status: number; error: string };

export type SendOutgoingParams = {
  clientId: number;
  chatId: string;
  text: string;
};

// Providers que no tienen backend externo: solo se persiste el saliente.
const WEB_PROVIDERS = new Set(['WEB', 'TEST']);

/**
 * Resuelve el provider del chat y envía un saliente por el protocolo correcto
 * (WEB / Unipile / Evolution). Persiste el mensaje de forma idempotente y
 * actualiza el preview del chat. Devuelve el message_id definitivo, que el
 * front usa para reconciliar el optimista y deduplicar el INSERT de Realtime.
 */
async function sendOutgoing(
  { clientId, chatId, text }: SendOutgoingParams,
  log: FastifyBaseLogger,
): Promise<SendResult> {
  // 1. Resolver el chat (scopeado al client).
  const { data: chat, error: chatError } = await supabase
    .from('unipile_chats')
    .select('chat_id, account_id, provider, contact_handle')
    .eq('chat_id', chatId)
    .eq('client_id', clientId)
    .maybeSingle();

  if (chatError) {
    log.error({ err: chatError, chatId }, 'outgoing: error resolviendo chat');
    return { ok: false, status: 500, error: 'DB error (chat)' };
  }
  if (!chat) {
    return { ok: false, status: 404, error: 'Chat not found' };
  }

  const provider = (chat.provider ?? '').toUpperCase();
  let messageId: string;

  // 2. Enviar según provider.
  if (WEB_PROVIDERS.has(provider)) {
    // Sin provider externo: solo persistir.
    messageId = randomUUID();
  } else {
    // El source del inbox (no el provider) distingue Unipile de Evolution.
    // Unipile matchea por account_id; Evolution por evolution_instance_name
    // (chat.account_id guarda el instance name). Buscamos por ambas columnas.
    const { data: inbox, error: inboxError } = await supabase
      .from('unipile_inboxes')
      .select('source, evolution_instance_name, account_status')
      .eq('client_id', clientId)
      .or(`account_id.eq.${chat.account_id},evolution_instance_name.eq.${chat.account_id}`)
      .maybeSingle();

    if (inboxError) {
      log.error({ err: inboxError, accountId: chat.account_id }, 'outgoing: error resolviendo inbox');
      return { ok: false, status: 500, error: 'DB error (inbox)' };
    }
    if (!inbox) {
      return { ok: false, status: 404, error: 'Chat not found' };
    }

    try {
      if (inbox.source === 'evolution') {
        if (inbox.account_status && inbox.account_status !== 'connected') {
          return { ok: false, status: 422, error: 'Inbox no conectado' };
        }
        const instanceName = chat.account_id as string;
        const number = chatId.split('@')[0];
        const resp = await evolutionApiService.sendText({ instanceName, number, text });
        messageId = resp.key?.id ?? randomUUID();
      } else {
        const resp = await unipileApiService.sendMessage(chatId, text);
        messageId = resp.id ?? resp.message_id ?? randomUUID();
      }
    } catch (err) {
      log.error({ err, chatId, source: inbox.source }, 'outgoing: falla del provider');
      return { ok: false, status: 502, error: 'Error al enviar mensaje' };
    }
  }

  // 3. Persistir el saliente de forma idempotente (el eco del provider reusa
  //    el mismo message_id y choca con el unique constraint → 23505, se ignora).
  const nowIso = new Date().toISOString();
  const { error: msgError } = await supabase.from('unipile_messages').insert({
    chat_id: chatId,
    client_id: clientId,
    message_id: messageId,
    content: text,
    direction: 'outgoing',
    sender_name: null,
    created_at: nowIso,
  });

  if (msgError && msgError.code !== '23505') {
    log.error({ err: msgError, chatId }, 'outgoing: message insert error');
    return { ok: false, status: 500, error: 'DB error (message)' };
  }

  // 4. Actualizar el preview del chat.
  const { error: chatUpdateError } = await supabase
    .from('unipile_chats')
    .update({
      last_message_preview: text.slice(0, 120),
      last_message_at: nowIso,
      updated_at: nowIso,
    })
    .eq('chat_id', chatId);

  if (chatUpdateError) {
    // El mensaje ya se envió y persistió; el preview es secundario, no fallamos.
    log.warn({ err: chatUpdateError, chatId }, 'outgoing: chat preview update falló (no bloqueante)');
  }

  log.info({ chatId, provider: provider || 'unknown', messageId }, 'outgoing: mensaje enviado');
  return { ok: true, message_id: messageId };
}

export const outgoingMessageService = {
  sendOutgoing,
};
