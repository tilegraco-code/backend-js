// Cliente HTTP de bajo nivel para MercadoLibre. Sin estado: recibe el access_token
// ya resuelto (de eso se ocupa mercadolibre.service). Patrón getCreds() igual que
// tiendanube-api.service.ts / evolution-api.service.ts.
import type {
  MercadolibreActionGuide,
  MercadolibreConversation,
  MercadolibreMessage,
  MercadolibreOrder,
  MercadolibreTokenResponse,
  MercadolibreUser,
} from '../types/mercadolibre';

const API_BASE = 'https://api.mercadolibre.com';
const TOKEN_URL = `${API_BASE}/oauth/token`;

/** Tope duro de ML para un mensaje del vendedor. Excederlo es un 400. */
export const MAX_MESSAGE_LENGTH = 350;

/**
 * Destinatario por defecto cuando no hay ningún entrante del que deducirlo.
 *
 * Desde el 02/02/2026 ML intermedia las conversaciones con Agentes de IA: el
 * `to.user_id` deja de ser el comprador real y pasa a ser el agente del país. Está
 * anunciado para MLB y MLC, pero la tabla publicada ya incluye a MLA, así que
 * asumimos que va a alcanzar a todos.
 *
 * Esto es SOLO un fallback. El camino normal es responderle a quien nos escribió
 * (el `from.user_id` del último entrante), que funciona igual antes y después de
 * la migración sin que tengamos que saber en qué lado estamos.
 */
const AGENT_USER_ID_BY_SITE: Record<string, string> = {
  MLA: '3037674934',
  MLB: '3037675074',
  MLC: '3020819166',
  MCO: '3037204123',
  MLM: '3037204279',
  MLU: '3037204685',
};

export function agentUserIdForSite(siteId: string | null | undefined): string | null {
  if (!siteId) return null;
  return AGENT_USER_ID_BY_SITE[siteId.toUpperCase()] ?? null;
}

/**
 * Error de la API con el `cause` de ML preservado. Los callers ramifican por
 * `cause` (p.ej. blocked_by_conversation_started_by_seller → reintentar por el
 * action guide), no por el texto del mensaje.
 */
export class MercadolibreApiError extends Error {
  readonly status: number;
  readonly cause: string | null;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'MercadolibreApiError';
    this.status = status;
    this.body = body;
    this.cause = extractCause(body);
  }
}

/** ML pone el código de error ya sea en `cause`, en `error` o en `message`. */
function extractCause(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { cause?: unknown; error?: unknown; message?: unknown };
    for (const key of ['cause', 'error', 'message'] as const) {
      const value = parsed[key];
      if (typeof value === 'string' && value.includes('_')) return value;
    }
  } catch {
    /* body no-JSON */
  }
  return null;
}

function getCreds(): { appId: string; clientSecret: string; redirectUri: string } {
  const appId = process.env.MERCADOLIBRE_APP_ID;
  const clientSecret = process.env.MERCADOLIBRE_CLIENT_SECRET;
  const redirectUri = process.env.MERCADOLIBRE_REDIRECT_URI;
  if (!appId || !clientSecret || !redirectUri) {
    throw new Error(
      'MERCADOLIBRE_APP_ID, MERCADOLIBRE_CLIENT_SECRET y/o MERCADOLIBRE_REDIRECT_URI no configuradas',
    );
  }
  return { appId, clientSecret, redirectUri };
}

async function tokenRequest(body: URLSearchParams): Promise<MercadolibreTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MercadolibreApiError(res.status, text, `MercadoLibre oauth/token ${res.status}`);
  }
  return JSON.parse(text) as MercadolibreTokenResponse;
}

/** GET contra la API con el token del vendedor. */
async function get<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MercadolibreApiError(res.status, text, `MercadoLibre GET ${path} ${res.status}`);
  }
  return JSON.parse(text) as T;
}

async function post<T>(path: string, token: string, payload: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MercadolibreApiError(res.status, text, `MercadoLibre POST ${path} ${res.status}`);
  }
  return JSON.parse(text) as T;
}

export const mercadolibreApiService = {
  /** Intercambia el authorization code por el primer par access/refresh. */
  async exchangeCode(code: string): Promise<MercadolibreTokenResponse> {
    const { appId, clientSecret, redirectUri } = getCreds();
    return tokenRequest(
      new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    );
  },

  /**
   * Renueva el access_token. OJO: el refresh_token es de un solo uso — esta
   * llamada lo invalida y devuelve uno nuevo que HAY que persistir. Serializar
   * las llamadas concurrentes es responsabilidad del caller.
   */
  async refreshToken(refreshToken: string): Promise<MercadolibreTokenResponse> {
    const { appId, clientSecret } = getCreds();
    return tokenRequest(
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: appId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      }),
    );
  },

  async fetchMe(token: string): Promise<MercadolibreUser> {
    return get<MercadolibreUser>('/users/me', token);
  },

  async fetchOrder(orderId: number | string, token: string): Promise<MercadolibreOrder> {
    return get<MercadolibreOrder>(`/orders/${orderId}`, token);
  },

  /**
   * Un mensaje por id. El `resource` de la notificación del tópico `messages` es
   * el id crudo (a veces con "/messages/" adelante) — normalizamos en el caller.
   */
  async fetchMessage(messageId: string, token: string): Promise<MercadolibreMessage> {
    return get<MercadolibreMessage>(
      `/messages/${encodeURIComponent(messageId)}?tag=post_sale`,
      token,
    );
  },

  /**
   * Conversación completa de un pack. `mark_as_read=false` porque leemos por
   * nuestra cuenta: marcar leído es decisión del dashboard, no un efecto colateral.
   */
  async fetchConversation(
    packId: string,
    sellerId: string,
    token: string,
  ): Promise<MercadolibreConversation> {
    return get<MercadolibreConversation>(
      `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale&mark_as_read=false`,
      token,
    );
  },

  /**
   * Opciones disponibles para que el VENDEDOR inicie la conversación.
   *
   * Un 400 con cause `blocked_by_excepted_case` no es un fallo: significa que esta
   * orden está exceptuada del action guide y puede usar la mensajería normal. Lo
   * devolvemos como dato en vez de tirar, porque cambia el camino de envío.
   */
  async fetchActionGuide(packId: string, token: string): Promise<MercadolibreActionGuide> {
    try {
      return await get<MercadolibreActionGuide>(
        `/messages/action_guide/packs/${packId}?tag=post_sale`,
        token,
      );
    } catch (err) {
      if (err instanceof MercadolibreApiError && err.status === 400 && err.cause) {
        return { cause: err.cause, status_code: 400 };
      }
      throw err;
    }
  },

  /**
   * Primer mensaje de una conversación que arranca el vendedor. Es el ÚNICO
   * camino: el POST normal a /messages/packs/… responde
   * `blocked_by_conversation_started_by_seller` mientras el comprador no haya escrito.
   *
   * `option_id: 'OTHER'` es el texto libre (350 chars). Un 200 NO garantiza entrega:
   * hay que mirar `message_moderation.status`, que puede venir `rejected`.
   */
  async sendActionGuideMessage(
    packId: string,
    token: string,
    text: string,
  ): Promise<MercadolibreMessage> {
    return post<MercadolibreMessage>(
      `/messages/action_guide/packs/${packId}/option?tag=post_sale`,
      token,
      { option_id: 'OTHER', text },
    );
  },

  /**
   * Mensaje en una conversación ya iniciada por el comprador.
   *
   * `toUserId` sale del `from.user_id` del último entrante, no del comprador de la
   * orden: si ML está intermediando con su Agente de IA, el destinatario es el
   * agente y mandarle al comprador real rebota con `Receiver does not belong to order`.
   */
  async sendPackMessage(
    packId: string,
    sellerId: string,
    toUserId: string,
    token: string,
    text: string,
  ): Promise<MercadolibreMessage> {
    return post<MercadolibreMessage>(
      `/messages/packs/${packId}/sellers/${sellerId}?tag=post_sale`,
      token,
      {
        from: { user_id: sellerId },
        to: { user_id: toUserId },
        text,
      },
    );
  },
};
