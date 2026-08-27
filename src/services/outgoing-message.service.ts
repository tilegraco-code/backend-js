import { randomUUID } from 'node:crypto';
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import { evolutionApiService } from './evolution-api.service';
import { unipileApiService } from './unipile-api.service';
import { mercadolibreService, prepareText } from './mercadolibre.service';

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
 * (WEB / Unipile / Evolution / MercadoLibre). Persiste el mensaje de forma idempotente y
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
  // Lo que realmente sale al canal. MercadoLibre recorta a 350 caracteres y no
  // acepta nada fuera de latin1, así que ahí difiere del `text` que nos pidieron:
  // persistimos lo enviado, no lo pedido, para que la bandeja no mienta.
  let sentText = text;

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
      .select('source, evolution_instance_name, account_status, suspended')
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
    // Canal suspendido por trial vencido o plan impago: no se envía nada.
    if (inbox.suspended === true) {
      return { ok: false, status: 402, error: 'Canal desconectado: activá un plan para reactivarlo' };
    }

    try {
      if (inbox.source === 'evolution') {
        if (inbox.account_status && inbox.account_status !== 'connected') {
          return { ok: false, status: 422, error: 'Inbox no conectado' };
        }
        const instanceName = chat.account_id as string;
        // El chat_id de Evolution es `${instance}:${remoteJid}`, asi que NO lo
        // parseamos para el numero: lo tomamos de contact_handle (el numero crudo).
        // Fallback defensivo: strip del prefijo de instancia y del dominio @.
        const number =
          chat.contact_handle ?? (chatId.split('@')[0]?.split(':').pop() as string);
        const resp = await evolutionApiService.sendText({ instanceName, number, text });
        messageId = resp.key?.id ?? randomUUID();
      } else if (inbox.source === 'mercadolibre') {
        // El chat_id de ML es `ml:${seller}:${pack}`: NO lo parseamos. El seller
        // está en account_id y el pack en contact_handle, igual que en Evolution.
        const mlUserId = Number(chat.account_id);
        const packId = chat.contact_handle;
        if (!Number.isFinite(mlUserId) || !packId) {
          return { ok: false, status: 422, error: 'Chat de MercadoLibre incompleto' };
        }
        sentText = prepareText(text, log);
        if (!sentText) {
          return { ok: false, status: 422, error: 'Mensaje vacío tras sanitizar para MercadoLibre' };
        }
        const resp = await mercadolibreService.sendMessage(
          { mlUserId, packId, text: sentText },
          log,
        );
        messageId = resp.id ?? resp.message_id ?? randomUUID();

        // ML devuelve 200 aunque el moderador rechace el mensaje: en ese caso el
        // comprador NO lo ve. No falla el envío (ya quedó registrado), pero tiene
        // que verse en los logs y no pasar por entrega exitosa.
        const moderation = resp.message_moderation ?? resp.moderation;
        if (
          resp.status?.toLowerCase() === 'moderated' ||
          moderation?.status?.toLowerCase() === 'rejected'
        ) {
          log.warn(
            { chatId, packId, reason: moderation?.reason },
            'mercadolibre: mensaje MODERADO por ML — el comprador no lo recibió',
          );
        }
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
    content: sentText,
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
      last_message_preview: sentText.slice(0, 120),
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
