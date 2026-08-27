// Procesamiento de las notificaciones de MercadoLibre.
//
// Dos flujos:
//   orders_v2 → cuando la orden pasa a `paid`, se le manda al comprador el DM de
//               venta confirmada (plantilla del canal, vía action guide).
//   messages  → un DM entrante se persiste y se despacha al agente.
//
// Espejo estructural de evolution-webhook.service.ts: el servicio decide y
// devuelve el forward, y la ejecución del agente queda en background del caller.
import { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import type { N8nForwardPayload } from './n8n-forward';
import { mercadolibreApiService } from './mercadolibre-api.service';
import { mercadolibreService, prepareText, renderSaleTemplate } from './mercadolibre.service';
import type {
  MercadolibreMessage,
  MercadolibreNotification,
  MercadolibreOrder,
} from '../types/mercadolibre';

type ProcessResult =
  | { ok: true; skipped?: string; forward?: { workflowId: number; payload: N8nForwardPayload } }
  | { ok: false; error: string };

type ResolvedInbox = {
  id: number;
  client_id: number;
  workflow_id: number | null;
  suspended: boolean | null;
  ml_sale_enabled: boolean | null;
  ml_sale_template: string | null;
};

// ---------- HELPERS ----------

/** `/orders/2195160686` → `2195160686`. También tolera el id pelado. */
function resourceId(resource: string): string | null {
  const match = resource.trim().match(/([^/]+)\/?$/);
  return match?.[1] ?? null;
}

/** El texto viene plano en el formato nuevo y como `{ plain }` en el viejo. */
function extractText(message: MercadolibreMessage): string {
  const { text } = message;
  if (typeof text === 'string') return text.trim();
  if (text && typeof text === 'object') return (text.plain ?? '').trim();
  return '';
}

/** Un mensaje pertenece a un pack; el id sale de `message_resources`. */
function packFromMessage(message: MercadolibreMessage): string | null {
  const fromResources = message.message_resources?.find((r) => r.name === 'packs')?.id;
  if (fromResources) return String(fromResources);
  // Formato viejo: resource/resource_id apuntando a la orden.
  if (message.resource === 'orders' && message.resource_id) return String(message.resource_id);
  return null;
}

function messageDate(message: MercadolibreMessage): string {
  const raw = message.message_date?.created ?? message.date_created;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}

/**
 * `chat_id` único global. El pack_id solo es único dentro de un vendedor, así que
 * lo prefijamos con el seller — mismo criterio que Evolution con `instance:remoteJid`.
 */
function buildChatId(mlUserId: number, packId: string): string {
  return `ml:${mlUserId}:${packId}`;
}

async function resolveInbox(mlUserId: number): Promise<ResolvedInbox | null> {
  const { data } = await supabase
    .from('unipile_inboxes')
    .select('id, client_id, workflow_id, suspended, ml_sale_enabled, ml_sale_template')
    .eq('account_id', String(mlUserId))
    .eq('source', 'mercadolibre')
    .maybeSingle();
  return (data as ResolvedInbox | null) ?? null;
}

/**
 * Upsert del chat: INSERT y, si choca el unique (23505), UPDATE del preview.
 * Idéntico al de Evolution — el entrante es la fuente autoritativa del contacto.
 */
async function upsertChat(input: {
  clientId: number;
  chatId: string;
  mlUserId: number;
  packId: string;
  workflowId: number | null;
  contactName: string;
  buyerId: string | null;
  preview: string;
  messageAt: string;
  isIncoming: boolean;
  log: FastifyBaseLogger;
}): Promise<boolean> {
  const { error } = await supabase.from('unipile_chats').insert({
    client_id: input.clientId,
    chat_id: input.chatId,
    account_id: String(input.mlUserId),
    workflow_id: input.workflowId,
    state: 'ia',
    provider: 'MERCADOLIBRE',
    contact_id: input.buyerId,
    contact_name: input.contactName,
    // El pack va acá para que el saliente no tenga que parsear el chat_id.
    contact_handle: input.packId,
    contact_avatar_url: null,
    last_message_preview: input.preview.slice(0, 120),
    last_message_at: input.messageAt,
  });

  if (!error) return true;

  if (error.code !== '23505') {
    input.log.error({ err: error, chatId: input.chatId }, 'mercadolibre: chat insert error');
    return false;
  }

  const patch: Record<string, unknown> = {
    last_message_preview: input.preview.slice(0, 120),
    last_message_at: input.messageAt,
    updated_at: new Date().toISOString(),
  };
  if (input.workflowId !== null) patch.workflow_id = input.workflowId;
  if (input.isIncoming) patch.contact_name = input.contactName;

  await supabase.from('unipile_chats').update(patch).eq('chat_id', input.chatId);
  return true;
}

/** Insert idempotente. Devuelve false si el mensaje ya estaba (reintento de ML). */
async function insertMessage(input: {
  chatId: string;
  clientId: number;
  messageId: string;
  content: string;
  direction: 'incoming' | 'outgoing';
  senderName: string | null;
  createdAt: string;
  log: FastifyBaseLogger;
}): Promise<boolean> {
  const { error } = await supabase.from('unipile_messages').insert({
    chat_id: input.chatId,
    client_id: input.clientId,
    message_id: input.messageId,
    content: input.content,
    direction: input.direction,
    sender_name: input.senderName,
    created_at: input.createdAt,
  });

  if (!error) return true;
  if (error.code === '23505') return false; // duplicado: ML reintenta hasta 5 veces
  input.log.error({ err: error, chatId: input.chatId }, 'mercadolibre: message insert error');
  return false;
}

/** El estado de moderación decide si el comprador realmente vio el mensaje. */
function greetStatusFrom(message: MercadolibreMessage): 'sent' | 'moderated' {
  const moderation = message.message_moderation ?? message.moderation;
  const rejected =
    message.status?.toLowerCase() === 'moderated' ||
    moderation?.status?.toLowerCase() === 'rejected';
  return rejected ? 'moderated' : 'sent';
}

// ---------- SERVICIO ----------

export const mercadolibreWebhookService = {
  /**
   * Trigger de venta confirmada. `orders_v2` notifica en CADA cambio de la orden,
   * así que casi todas las pasadas terminan sin mandar nada — la fila de
   * mercadolibre_orders es la que garantiza un solo DM por venta.
   */
  async processOrder(
    notification: MercadolibreNotification,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult> {
    const orderId = resourceId(notification.resource);
    if (!orderId) return { ok: true, skipped: 'no_order_id' };

    const mlUserId = notification.user_id;
    const conn = await mercadolibreService.getConnection(mlUserId);
    if (!conn) return { ok: true, skipped: 'unknown_seller' };

    const inbox = await resolveInbox(mlUserId);
    if (!inbox) return { ok: true, skipped: 'no_inbox' };
    if (inbox.suspended === true) {
      log.warn({ mlUserId, inbox_id: inbox.id }, 'mercadolibre: orden en inbox suspendido — ignorada');
      return { ok: true, skipped: 'inbox_suspended' };
    }

    let order: MercadolibreOrder;
    try {
      const token = await mercadolibreService.getValidToken(mlUserId);
      order = await mercadolibreApiService.fetchOrder(orderId, token);
    } catch (err) {
      log.error({ err, orderId, mlUserId }, 'mercadolibre: no se pudo traer la orden');
      return { ok: false, error: 'order_fetch_failed' };
    }

    const packId = String(order.pack_id ?? order.id);
    const buyerName = order.buyer?.nickname ?? null;
    const firstItem = order.order_items?.[0]?.item?.title ?? null;

    // Snapshot de la orden. `greeted_at` NO se toca acá: lo escribe el claim.
    const { error: upsertError } = await supabase.from('mercadolibre_orders').upsert(
      {
        order_id: Number(order.id),
        ml_user_id: mlUserId,
        client_id: inbox.client_id,
        pack_id: order.pack_id ?? null,
        status: order.status,
        buyer_id: order.buyer?.id != null ? Number(order.buyer.id) : null,
        buyer_name: buyerName,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'order_id' },
    );
    if (upsertError) {
      log.error({ err: upsertError, orderId }, 'mercadolibre: orders upsert error');
      return { ok: false, error: 'db_error' };
    }

    if (order.status !== 'paid') return { ok: true, skipped: `status:${order.status}` };
    // Dos condiciones separadas a propósito: el cliente puede apagar el aviso sin
    // perder la plantilla que eligió.
    if (inbox.ml_sale_enabled !== true) return { ok: true, skipped: 'sale_message_off' };
    if (!inbox.ml_sale_template) return { ok: true, skipped: 'no_template' };

    const body = prepareText(
      renderSaleTemplate(inbox.ml_sale_template, {
        comprador: buyerName,
        producto: firstItem,
        orden: String(order.id),
        total: order.total_amount != null ? String(order.total_amount) : null,
      }),
      log,
    );
    if (!body) return { ok: true, skipped: 'empty_template' };

    // Claim atómico: el UPDATE condicionado a greeted_at IS NULL hace que dos
    // notificaciones concurrentes de la misma orden no manden el DM dos veces.
    const { data: claimed, error: claimError } = await supabase
      .from('mercadolibre_orders')
      .update({ greeted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('order_id', Number(order.id))
      .is('greeted_at', null)
      .select('order_id');

    if (claimError) {
      log.error({ err: claimError, orderId }, 'mercadolibre: claim error');
      return { ok: false, error: 'db_error' };
    }
    if (!claimed?.length) return { ok: true, skipped: 'already_greeted' };

    const finish = async (status: string, extra?: Record<string, unknown>) => {
      await supabase
        .from('mercadolibre_orders')
        .update({ greet_status: status, updated_at: new Date().toISOString(), ...extra })
        .eq('order_id', Number(order.id));
    };

    // El vendedor arranca la conversación: el único camino es el action guide, y
    // solo si le queda cupo. Un `blocked_by_excepted_case` significa lo contrario:
    // esta orden está exceptuada y puede usar la mensajería normal.
    let viaActionGuide = true;
    try {
      const token = await mercadolibreService.getValidToken(mlUserId);
      const guide = await mercadolibreApiService.fetchActionGuide(packId, token);

      if (guide.cause === 'blocked_by_excepted_case') {
        viaActionGuide = false;
      } else {
        const other = guide.options?.find((o) => o.id === 'OTHER');
        if (!other || (other.cap_available ?? 0) < 1) {
          log.info({ orderId, packId }, 'mercadolibre: sin cupo para iniciar la conversación');
          await finish('no_cap');
          return { ok: true, skipped: 'no_cap' };
        }
      }
    } catch (err) {
      // Acá solo caen 5xx, errores de red y 403 (p.ej. Full sin entregar). Los
      // 400 con `cause` los devuelve fetchActionGuide como dato, no como excepción.
      // Todos esos casos pueden dejar de aplicar más adelante, así que liberamos el
      // claim: la próxima notificación de la orden vuelve a intentarlo.
      log.error({ err, packId }, 'mercadolibre: action guide falló');
      await finish('blocked', { greeted_at: null });
      return { ok: true, skipped: 'action_guide_failed' };
    }

    let sent: MercadolibreMessage;
    try {
      const token = await mercadolibreService.getValidToken(mlUserId);
      sent = viaActionGuide
        ? await mercadolibreApiService.sendActionGuideMessage(packId, token, body)
        : await mercadolibreService.sendMessage({ mlUserId, packId, text: body }, log);
    } catch (err) {
      log.error({ err, orderId, packId }, 'mercadolibre: falló el DM de venta confirmada');
      await finish('failed', { greeted_at: null }); // liberar el claim para reintentar
      return { ok: false, error: 'send_failed' };
    }

    const status = greetStatusFrom(sent);
    if (status === 'moderated') {
      log.warn(
        { orderId, packId, reason: (sent.message_moderation ?? sent.moderation)?.reason },
        'mercadolibre: el DM de venta confirmada fue moderado — el comprador NO lo vio',
      );
    }

    const nowIso = new Date().toISOString();
    const chatId = buildChatId(mlUserId, packId);
    const messageId = sent.id ?? sent.message_id ?? `ml-greet-${order.id}`;

    await upsertChat({
      clientId: inbox.client_id,
      chatId,
      mlUserId,
      packId,
      workflowId: inbox.workflow_id,
      contactName: buyerName ?? 'Comprador',
      buyerId: order.buyer?.id != null ? String(order.buyer.id) : null,
      preview: body,
      messageAt: nowIso,
      isIncoming: false,
      log,
    });
    await insertMessage({
      chatId,
      clientId: inbox.client_id,
      messageId,
      content: body,
      direction: 'outgoing',
      senderName: null,
      createdAt: nowIso,
      log,
    });

    await finish(status);
    log.info({ orderId, packId, status }, 'mercadolibre: DM de venta confirmada enviado');
    return { ok: true };
  },

  /**
   * DM entrante. Decide si forwardear al agente (sin ejecutarlo — eso queda en
   * background del caller, igual que en Evolution).
   */
  async processMessage(
    notification: MercadolibreNotification,
    log: FastifyBaseLogger,
  ): Promise<ProcessResult> {
    // El tópico `messages` también notifica lecturas; solo nos interesan las altas.
    const actions = notification.actions ?? [];
    if (actions.length && !actions.includes('created')) {
      return { ok: true, skipped: `actions:${actions.join(',')}` };
    }

    const messageId = resourceId(notification.resource);
    if (!messageId) return { ok: true, skipped: 'no_message_id' };

    const mlUserId = notification.user_id;
    const conn = await mercadolibreService.getConnection(mlUserId);
    if (!conn) return { ok: true, skipped: 'unknown_seller' };

    const inbox = await resolveInbox(mlUserId);
    if (!inbox) return { ok: true, skipped: 'no_inbox' };
    if (inbox.suspended === true) {
      log.warn({ mlUserId, inbox_id: inbox.id }, 'mercadolibre: mensaje en inbox suspendido — ignorado');
      return { ok: true, skipped: 'inbox_suspended' };
    }

    let message: MercadolibreMessage;
    try {
      const token = await mercadolibreService.getValidToken(mlUserId);
      message = await mercadolibreApiService.fetchMessage(messageId, token);
    } catch (err) {
      log.error({ err, messageId, mlUserId }, 'mercadolibre: no se pudo traer el mensaje');
      return { ok: false, error: 'message_fetch_failed' };
    }

    // Eco de lo que mandamos nosotros.
    if (message.from?.user_id != null && String(message.from.user_id) === String(mlUserId)) {
      return { ok: true, skipped: 'own_message' };
    }

    const packId = packFromMessage(message);
    if (!packId) return { ok: true, skipped: 'no_pack' };

    const text = extractText(message);
    if (!text) return { ok: true, skipped: 'no_text' };

    // El nombre del remitente: ML no siempre lo manda. La orden que ya vimos suele
    // tener el nickname del comprador, así que lo reusamos antes de caer al genérico.
    let contactName = message.from?.name?.trim() || null;
    if (!contactName) {
      // En órdenes simples pack_id es NULL en la tabla y el "pack" que usamos es
      // el propio order_id, así que hay que mirar las dos columnas.
      const { data: known } = await supabase
        .from('mercadolibre_orders')
        .select('buyer_name')
        .eq('ml_user_id', mlUserId)
        .or(`pack_id.eq.${packId},order_id.eq.${packId}`)
        .not('buyer_name', 'is', null)
        .limit(1)
        .maybeSingle();
      contactName = (known?.buyer_name as string | undefined) ?? null;
    }
    contactName = contactName ?? 'Comprador';

    const chatId = buildChatId(mlUserId, packId);
    const msgAt = messageDate(message);
    const realMessageId = message.id ?? message.message_id ?? messageId;

    const chatOk = await upsertChat({
      clientId: inbox.client_id,
      chatId,
      mlUserId,
      packId,
      workflowId: inbox.workflow_id,
      contactName,
      buyerId: message.from?.user_id != null ? String(message.from.user_id) : null,
      preview: text,
      messageAt: msgAt,
      isIncoming: true,
      log,
    });
    if (!chatOk) return { ok: false, error: 'db_error' };

    const isNew = await insertMessage({
      chatId,
      clientId: inbox.client_id,
      messageId: realMessageId,
      content: text,
      direction: 'incoming',
      senderName: contactName,
      createdAt: msgAt,
      log,
    });
    if (!isNew) return { ok: true, skipped: 'duplicate' };

    await supabase.rpc('increment_unipile_unread', { p_chat_id: chatId });

    const { data: chat } = await supabase
      .from('unipile_chats')
      .select('state, workflow_id')
      .eq('chat_id', chatId)
      .single();

    if (chat?.state === 'ia' && chat.workflow_id) {
      return {
        ok: true,
        forward: {
          workflowId: chat.workflow_id,
          payload: { chat_id: chatId, nombre: contactName, question: text },
        },
      };
    }

    return { ok: true };
  },
};
