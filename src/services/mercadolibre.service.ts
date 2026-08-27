// Conexión + tokens + envío de MercadoLibre.
// - Conexión: tabla mercadolibre_connections (1 fila por cuenta de ML).
// - Canal: fila en unipile_inboxes con source='mercadolibre'.
// Ver docs/mercadolibre-canal-plan.md.
import type { FastifyBaseLogger } from 'fastify';
import { supabase } from '../lib/supabase';
import {
  MAX_MESSAGE_LENGTH,
  MercadolibreApiError,
  agentUserIdForSite,
  mercadolibreApiService,
} from './mercadolibre-api.service';
import type { MercadolibreMessage } from '../types/mercadolibre';

export type MercadolibreConnection = {
  id: number;
  client_id: number;
  ml_user_id: number;
  site_id: string;
  nickname: string | null;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scope: string | null;
  connected_at: string;
};

/** Margen para refrescar antes de que expire, y no perder una request por 10 s. */
const REFRESH_MARGIN_MS = 10 * 60_000;

/**
 * Refreshes en vuelo, por cuenta. El refresh_token de ML es de UN SOLO USO: dos
 * refreshes concurrentes sobre la misma conexión hacen que el segundo invalide el
 * token que acaba de guardar el primero, y la cuenta queda desconectada.
 *
 * Un mutex en memoria alcanza porque backend-js corre una sola instancia. El día
 * que haya réplicas esto necesita un lock compartido (advisory lock de Postgres o
 * Redis) — ver la decisión de posponer Redis en docs/.
 */
const refreshLocks = new Map<number, Promise<string>>();

/**
 * ML acepta ISO-8859-1 latin1 más una lista corta de emojis. Cualquier otro
 * carácter hace fallar el POST entero con 400 ("The text has character/s that
 * is/are not supported"), así que preferimos perder un emoji a perder el mensaje.
 */
function sanitize(text: string): string {
  // Rango latin1 imprimible, mas tab / LF / CR. Todo lo demas (emojis incluidos) se cae.
  // eslint-disable-next-line no-control-regex
  return text.replace(/[^\x09\x0A\x0D\x20-\xFF]/g, '');
}

/** Recorta a los 350 caracteres de ML. El "..." es ASCII a propósito: "…" no es latin1. */
function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 3).trimEnd()}...`;
}

/** Deja el texto listo para ML: sin caracteres inválidos y dentro del tope. */
export function prepareText(text: string, log?: FastifyBaseLogger): string {
  const clean = sanitize(text);
  if (clean.length !== text.length) {
    log?.warn(
      { removed: text.length - clean.length },
      'mercadolibre: caracteres fuera de latin1 removidos del mensaje',
    );
  }
  const final = truncate(clean.trim());
  if (final.length < clean.trim().length) {
    log?.warn({ original: clean.length }, 'mercadolibre: mensaje truncado a 350 caracteres');
  }
  return final;
}

/**
 * Renderiza la plantilla del aviso de venta. Las variables sin dato se reemplazan
 * por vacío y se colapsan los espacios, para no dejar "Hola , tu compra".
 */
export function renderSaleTemplate(
  template: string,
  vars: { comprador?: string | null; producto?: string | null; orden?: string | null; total?: string | null },
): string {
  return template
    .replace(/\{comprador\}/g, vars.comprador ?? '')
    .replace(/\{producto\}/g, vars.producto ?? '')
    .replace(/\{orden\}/g, vars.orden ?? '')
    .replace(/\{total\}/g, vars.total ?? '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ([,.!?])/g, '$1')
    // Una variable vacía puede dejar puntuación huérfana pegada a la siguiente
    // ("¡Gracias por tu compra,!"). Gana el signo fuerte.
    .replace(/([,;:])+\s*([.!?])/g, '$2')
    .trim();
}

export const mercadolibreService = {
  async getConnection(mlUserId: number): Promise<MercadolibreConnection | null> {
    const { data, error } = await supabase
      .from('mercadolibre_connections')
      .select('*')
      .eq('ml_user_id', mlUserId)
      .maybeSingle();
    if (error) throw error;
    return (data as MercadolibreConnection | null) ?? null;
  },

  async saveConnection(input: {
    clientId: number;
    mlUserId: number;
    siteId: string;
    nickname: string | null;
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
    scope: string | null;
  }): Promise<void> {
    const now = new Date();
    const { error } = await supabase.from('mercadolibre_connections').upsert(
      {
        client_id: input.clientId,
        ml_user_id: input.mlUserId,
        site_id: input.siteId,
        nickname: input.nickname,
        access_token: input.accessToken,
        refresh_token: input.refreshToken,
        expires_at: new Date(now.getTime() + input.expiresIn * 1000).toISOString(),
        scope: input.scope,
        connected_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      { onConflict: 'ml_user_id' },
    );
    if (error) throw error;
  },

  /** Borra la conexión (revoca nuestro acceso). Usado por el corte de ciclo de vida. */
  async deleteConnection(mlUserId: number): Promise<void> {
    const { error } = await supabase
      .from('mercadolibre_connections')
      .delete()
      .eq('ml_user_id', mlUserId);
    if (error) throw error;
  },

  /**
   * Access token válido para la cuenta. Refresca si está por vencer, serializando
   * los refreshes concurrentes contra la misma cuenta.
   */
  async getValidToken(mlUserId: number): Promise<string> {
    const conn = await this.getConnection(mlUserId);
    if (!conn) {
      throw new Error(`No hay conexión de MercadoLibre para el vendedor ${mlUserId}`);
    }

    if (Date.parse(conn.expires_at) - Date.now() > REFRESH_MARGIN_MS) {
      return conn.access_token;
    }

    const inFlight = refreshLocks.get(mlUserId);
    if (inFlight) return inFlight;

    const promise = (async () => {
      const token = await mercadolibreApiService.refreshToken(conn.refresh_token);
      await this.saveConnection({
        clientId: conn.client_id,
        mlUserId: conn.ml_user_id,
        siteId: conn.site_id,
        nickname: conn.nickname,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresIn: token.expires_in,
        scope: token.scope ?? conn.scope,
      });
      return token.access_token;
    })().finally(() => refreshLocks.delete(mlUserId));

    refreshLocks.set(mlUserId, promise);
    return promise;
  },

  /** Crea o actualiza la fila del canal. Idempotente por (client_id, account_id). */
  async upsertInbox(input: {
    clientId: number;
    mlUserId: number;
    displayName: string;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await supabase.from('unipile_inboxes').upsert(
      {
        client_id: input.clientId,
        account_id: String(input.mlUserId),
        source: 'mercadolibre',
        provider: 'MERCADOLIBRE',
        display_name: input.displayName,
        account_status: 'connected',
        // Reconectar después de un corte levanta la suspensión.
        suspended: false,
        suspended_reason: null,
        suspended_at: null,
        updated_at: now,
      },
      { onConflict: 'client_id,account_id' },
    );
    if (error) throw error;
  },

  /**
   * Envía un mensaje al comprador eligiendo el endpoint según quién arrancó.
   *
   * ML no deja que el vendedor inicie una conversación por la mensajería normal.
   * Mientras el comprador no haya escrito, el único camino es el action guide
   * (texto libre de 350 chars, con cupo). Una vez que contestó, se usa el POST
   * directo, respondiéndole a quien nos escribió.
   *
   * Consultamos la conversación en ML y no nuestra tabla: es la fuente
   * autoritativa de si hay entrantes, y de paso nos da el `to.user_id` correcto
   * (que puede ser el Agente de IA de ML y no el comprador).
   */
  async sendMessage(
    { mlUserId, packId, text }: { mlUserId: number; packId: string; text: string },
    log: FastifyBaseLogger,
  ): Promise<MercadolibreMessage> {
    const token = await this.getValidToken(mlUserId);
    const sellerId = String(mlUserId);
    const body = prepareText(text, log);
    if (!body) throw new Error('Mensaje vacío tras sanitizar');

    const conn = await this.getConnection(mlUserId);
    let toUserId: string | null = null;

    try {
      const conv = await mercadolibreApiService.fetchConversation(packId, sellerId, token);
      const inbound = (conv.messages ?? [])
        .filter((m) => m.from?.user_id != null && String(m.from.user_id) !== sellerId)
        .sort((a, b) => {
          const da = Date.parse(a.message_date?.created ?? a.date_created ?? '') || 0;
          const db = Date.parse(b.message_date?.created ?? b.date_created ?? '') || 0;
          return da - db;
        })
        .pop();
      if (inbound?.from?.user_id != null) toUserId = String(inbound.from.user_id);
    } catch (err) {
      log.warn({ err, packId }, 'mercadolibre: no se pudo leer la conversación, se asume sin entrantes');
    }

    // Sin entrantes → la conversación la arranca el vendedor → action guide.
    if (!toUserId) {
      return mercadolibreApiService.sendActionGuideMessage(packId, token, body);
    }

    try {
      return await mercadolibreApiService.sendPackMessage(packId, sellerId, toUserId, token, body);
    } catch (err) {
      // ML considera que el vendedor sigue iniciando (p.ej. el entrante que vimos
      // era del Agente y no cuenta como respuesta del comprador): reintentar por
      // el action guide antes de darlo por perdido.
      if (
        err instanceof MercadolibreApiError &&
        err.cause === 'blocked_by_conversation_started_by_seller'
      ) {
        log.warn({ packId }, 'mercadolibre: POST directo bloqueado, reintentando por action guide');
        return mercadolibreApiService.sendActionGuideMessage(packId, token, body);
      }
      // Destinatario rechazado: último recurso, el agente del país.
      if (err instanceof MercadolibreApiError && err.status === 403) {
        const fallback = agentUserIdForSite(conn?.site_id);
        if (fallback && fallback !== toUserId) {
          log.warn({ packId, fallback }, 'mercadolibre: 403 al destinatario, reintentando con el agente del sitio');
          return mercadolibreApiService.sendPackMessage(packId, sellerId, fallback, token, body);
        }
      }
      throw err;
    }
  },
};
