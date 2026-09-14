// Tipos de la API y de las notificaciones de MercadoLibre.
// Modelamos solo lo que consumimos; el resto de los campos queda en el index signature.

// ---------- OAuth ----------

export type MercadolibreTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number; // segundos
  scope?: string;
  user_id: number;
  refresh_token: string;
};

/** Subset de GET /users/me. */
export type MercadolibreUser = {
  id: number;
  nickname?: string;
  site_id?: string;
  [key: string]: unknown;
};

// ---------- Notificaciones ----------

/**
 * Payload del callback de notificaciones. ML manda UNA sola URL por aplicación
 * (no una por vendedor), así que `user_id` — el vendedor — es lo único con lo que
 * podemos resolver a qué cliente nuestro pertenece el evento.
 */
export type MercadolibreNotification = {
  resource: string;
  user_id: number;
  topic: string;
  application_id?: number;
  actions?: string[];
  attempts?: number;
  sent?: string;
  received?: string;
};

// ---------- Órdenes ----------

export type MercadolibreOrderItem = {
  item?: { id?: string; title?: string; variation_id?: number | null };
  quantity?: number;
  unit_price?: number;
  currency_id?: string;
};

/**
 * Subset de GET /orders/{id}.
 *
 * `status` recorre: confirmed → payment_required → payment_in_process →
 * partially_paid → paid, y puede terminar en partially_refunded / pending_cancel /
 * cancelled. El trigger de venta confirmada dispara en `paid`.
 *
 * `pack_id` es null en órdenes simples (una sola publicación, sin carrito). La
 * mensajería igual se direcciona por /packs, usando el order_id en su lugar.
 */
export type MercadolibreOrder = {
  id: number;
  status: string;
  status_detail?: string | null;
  pack_id?: number | null;
  date_created?: string;
  date_closed?: string;
  total_amount?: number;
  currency_id?: string;
  order_items?: MercadolibreOrderItem[];
  buyer?: { id?: number | string; nickname?: string };
  seller?: { id?: number | string };
  shipping?: { id?: number };
  tags?: string[];
  [key: string]: unknown;
};

// ---------- Mensajería ----------

export type MercadolibreMessageResource = {
  id: string;
  name: string; // 'packs' | 'sellers' | …
};

/** Un adjunto de un mensaje. Los bytes se bajan aparte, con el token del vendedor. */
export type MercadolibreAttachment = {
  /** Id con el que se pide el archivo; en ML suele tener forma de nombre de archivo. */
  filename?: string;
  original_filename?: string;
  name?: string;
  id?: string;
  type?: string;
  mimetype?: string;
  size?: number;
};

export type MercadolibreMessageModeration = {
  status?: string; // clean | rejected | pending | non_moderated
  reason?: string | null;
  source?: string;
  moderation_date?: string | null;
};

/**
 * Un mensaje. La API devuelve dos formas según el endpoint (la vieja plana y la
 * nueva anidada), así que aceptamos las dos y normalizamos al leer.
 */
export type MercadolibreMessage = {
  id?: string;
  message_id?: string;
  site_id?: string;
  from?: { user_id?: number | string; name?: string; email?: string };
  to?: { user_id?: number | string; name?: string };
  status?: string;
  subject?: string | null;
  /** Plano en el formato nuevo; { plain } en el viejo. */
  text?: string | { plain?: string };
  message_date?: {
    received?: string | null;
    available?: string | null;
    notified?: string | null;
    created?: string | null;
    read?: string | null;
  };
  date_created?: string;
  message_moderation?: MercadolibreMessageModeration;
  moderation?: MercadolibreMessageModeration;
  /**
   * Archivos que mandó el comprador. ML los nombra `message_attachments`, pero se acepta
   * también `attachments` porque la forma del payload de mensajería cambió entre versiones
   * y esto no está verificado contra un mensaje real con adjunto.
   */
  message_attachments?: MercadolibreAttachment[];
  attachments?: MercadolibreAttachment[];
  message_resources?: MercadolibreMessageResource[];
  resource?: string;
  resource_id?: string;
  [key: string]: unknown;
};

/** Respuesta de GET /messages/packs/{pack}/sellers/{seller}. */
export type MercadolibreConversation = {
  paging?: { limit?: number; offset?: number; total?: number };
  conversation_status?: {
    path?: string;
    status?: string;
    substatus?: string | null;
  } | null;
  messages?: MercadolibreMessage[];
  seller_max_message_length?: number;
  buyer_max_message_length?: number;
};

// ---------- Preguntas ----------

/**
 * Estado de una pregunta en ML. Solo `UNANSWERED` admite respuesta; `UNDER_REVIEW`
 * está en moderación y puede volver a UNANSWERED o terminar BANNED.
 */
export type MercadolibreQuestionStatus =
  | 'UNANSWERED'
  | 'ANSWERED'
  | 'CLOSED_UNANSWERED'
  | 'UNDER_REVIEW'
  | 'BANNED'
  | 'DELETED'
  | 'DISABLED'
  | string;

/**
 * Subset de GET /questions/{id}?api_version=4.
 *
 * OJO con el comprador: la consulta por id lo trae como `buyer_id` en la raíz, y
 * `/questions/search` como `from: { id }`. Aceptamos las dos formas (ver buyerIdOf).
 * El nickname no viene en ninguna: sale de /users/{id}.
 *
 * Una pregunta o respuesta BANNED llega con `text` vacío.
 */
export type MercadolibreQuestion = {
  id: number;
  seller_id?: number;
  buyer_id?: number;
  item_id: string;
  text: string;
  status: MercadolibreQuestionStatus;
  date_created?: string;
  last_updated?: string;
  deleted_from_listing?: boolean;
  suspected_spam?: boolean;
  hold?: boolean;
  from?: { id?: number };
  /** `status` de la respuesta: active | disabled | BANNED. */
  answer?: { text?: string; status?: string; date_created?: string } | null;
  [key: string]: unknown;
};

// ---------- Publicaciones ----------

/** Subset de GET /items/{id}: lo que le sirve al agente para responder. */
export type MercadolibreItem = {
  id: string;
  title?: string;
  price?: number;
  currency_id?: string;
  available_quantity?: number;
  condition?: string;
  permalink?: string;
  thumbnail?: string;
  secure_thumbnail?: string;
  status?: string;
  warranty?: string | null;
  shipping?: { free_shipping?: boolean; local_pick_up?: boolean };
  attributes?: { id?: string; name?: string; value_name?: string | null }[];
  variations?: {
    id?: number;
    available_quantity?: number;
    attribute_combinations?: { name?: string; value_name?: string | null }[];
  }[];
  [key: string]: unknown;
};

// ---------- Action guide ----------

export type MercadolibreActionGuideOption = {
  id: string; // REQUEST_VARIANTS | REQUEST_BILLING_INFO | SEND_INVOICE_LINK | DELIVERY_PROMISE | OTHER
  enabled?: boolean;
  type?: string; // template | free_text
  actionable?: boolean;
  char_limit?: number | null;
  cap_available?: number;
  templates?: { id: string; vars?: unknown }[] | null;
};

export type MercadolibreActionGuide = {
  options?: MercadolibreActionGuideOption[];
  /** Presente cuando ML responde 400: p.ej. 'blocked_by_excepted_case'. */
  cause?: string;
  error?: string;
  message?: string;
  status_code?: number;
};
