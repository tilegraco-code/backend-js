// Conexión + caché read-through de TiendaNube.
// - Conexión: tabla tiendanube_connections (una fila por tienda, puede haber varias por
//   cliente; ver lib/integration-connection).
// - Caché: tabla tiendanube_cache (snapshot JSON por (connection_id, resource), TTL 1h).
import { supabase } from '../lib/supabase';
import { findConnection, listConnections, notConnectedMessage } from '../lib/integration-connection';
import { tiendanubeApiService, TiendanubeStore } from './tiendanube-api.service';

export type CreateCheckoutInput = {
  name: string;
  lastname?: string;
  email: string;
  phone?: string;
  products: { variant_id: number; quantity: number }[];
  note?: string;
};

export type CreateCheckoutResult = {
  checkout_url: string | null;
  draft_order_id: number;
  total: string | null;
  discount: string | null;
  discount_coupon: string | null;
  discount_gateway: string | null;
  currency: string | null;
};

export type TiendanubeResource = 'products' | 'orders' | 'carts';

export type TiendanubeConnection = {
  id: number;
  client_id: number;
  store_id: number;
  access_token: string;
  token_type: string;
  scope: string | null;
  store_name: string | null;
  store_url: string | null;
  connected_at: string;
};

function ttlMs(): number {
  const minutes = Number(process.env.TIENDANUBE_CACHE_TTL_MINUTES ?? 60);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

/** Extrae un nombre legible del campo `name` de TiendaNube (puede ser i18n). */
function pickStoreName(store: TiendanubeStore): string | null {
  const name = store.name;
  if (!name) return null;
  if (typeof name === 'string') return name;
  return name.es ?? name.pt ?? Object.values(name)[0] ?? null;
}

/** Moneda principal de la tienda (los precios vienen en esta moneda). */
function pickCurrency(store: TiendanubeStore): string | null {
  return store.main_currency ?? store.currency ?? null;
}

// Caché en memoria de la moneda por conexión. La moneda casi nunca cambia, así que
// evitamos pegarle a GET /store en cada request. Backend long-running (Fastify): OK.
const currencyCache = new Map<number, { currency: string | null; ts: number }>();
const CURRENCY_TTL_MS = 24 * 60 * 60_000; // 24h

const FETCHERS: Record<
  TiendanubeResource,
  (storeId: number, token: string) => Promise<unknown[]>
> = {
  products: (s, t) => tiendanubeApiService.fetchProducts(s, t),
  orders: (s, t) => tiendanubeApiService.fetchOrders(s, t),
  carts: (s, t) => tiendanubeApiService.fetchCarts(s, t),
};

export const tiendanubeService = {
  async getConnection(clientId: number, connectionId?: number | null): Promise<TiendanubeConnection | null> {
    return findConnection<TiendanubeConnection>('tiendanube_connections', clientId, connectionId);
  },

  async listConnections(clientId: number): Promise<TiendanubeConnection[]> {
    return listConnections<TiendanubeConnection>('tiendanube_connections', clientId);
  },

  /** Conexión o error claro para el agente. */
  async requireConnection(clientId: number, connectionId?: number | null): Promise<TiendanubeConnection> {
    const conn = await this.getConnection(clientId, connectionId);
    if (!conn) throw new Error(notConnectedMessage('TiendaNube', connectionId));
    return conn;
  },

  async saveConnection(input: {
    clientId: number;
    storeId: number;
    accessToken: string;
    tokenType: string;
    scope: string | null;
    storeName: string | null;
    storeUrl: string | null;
  }): Promise<void> {
    // Reconectar la misma tienda actualiza su fila (las tools que la apuntan siguen
    // andando); otra tienda se suma como una conexión más.
    const { error } = await supabase.from('tiendanube_connections').upsert(
      {
        client_id: input.clientId,
        store_id: input.storeId,
        access_token: input.accessToken,
        token_type: input.tokenType,
        scope: input.scope,
        store_name: input.storeName,
        store_url: input.storeUrl,
        connected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id,store_id' },
    );
    if (error) throw error;
  },

  /** Trae datos básicos de la tienda recién conectada (para guardar nombre/url). */
  async fetchStoreInfo(
    storeId: number,
    token: string,
  ): Promise<{ name: string | null; url: string | null }> {
    const store = await tiendanubeApiService.fetchStore(storeId, token);
    return {
      name: pickStoreName(store),
      url: store.url_with_protocol ?? store.original_domain ?? null,
    };
  },

  /**
   * Moneda principal de la tienda (ej "ARS"). Cacheada en memoria 24h; se
   * resuelve con un GET /store la primera vez. Devuelve null si no hay conexión
   * o si TiendaNube no la informa.
   */
  async getCurrency(clientId: number, connectionId?: number | null): Promise<string | null> {
    const conn = await this.getConnection(clientId, connectionId);
    if (!conn) return null;

    const hit = currencyCache.get(conn.id);
    if (hit && Date.now() - hit.ts < CURRENCY_TTL_MS) return hit.currency;

    let currency: string | null = null;
    try {
      const store = await tiendanubeApiService.fetchStore(conn.store_id, conn.access_token);
      currency = pickCurrency(store);
    } catch {
      currency = null;
    }

    currencyCache.set(conn.id, { currency, ts: Date.now() });
    return currency;
  },

  /**
   * Crea un draft order en la tienda del cliente y devuelve el checkout_url
   * listo para pagar. El cliente coordina envío y descuentos en el checkout.
   */
  async createCheckout(
    clientId: number,
    input: CreateCheckoutInput,
    connectionId?: number | null,
  ): Promise<CreateCheckoutResult> {
    const conn = await this.requireConnection(clientId, connectionId);
    if (!input.products?.length) {
      throw new Error('Se requiere al menos un producto (variant_id + quantity)');
    }

    const draft = await tiendanubeApiService.createDraftOrder(conn.store_id, conn.access_token, {
      contact_name: input.name,
      contact_lastname: input.lastname || '-', // TiendaNube lo exige; placeholder si no hay
      contact_email: input.email,
      ...(input.phone ? { contact_phone: input.phone } : {}),
      payment_status: 'unpaid',
      products: input.products.map((p) => ({
        variant_id: p.variant_id,
        quantity: p.quantity,
      })),
      ...(input.note ? { note: input.note } : {}),
    });

    return {
      checkout_url: draft.checkout_url ?? null,
      draft_order_id: draft.id,
      total: draft.total ?? null,
      discount: draft.discount ?? null,
      discount_coupon: draft.discount_coupon ?? null,
      discount_gateway: draft.discount_gateway ?? null,
      currency: await this.getCurrency(clientId, conn.id),
    };
  },

  /**
   * Núcleo del caché read-through. Devuelve el snapshot del recurso de una tienda:
   * HIT si está fresco (expires_at > now), MISS si no (refetch + upsert).
   */
  async getCachedResource(
    clientId: number,
    resource: TiendanubeResource,
    connectionId?: number | null,
  ): Promise<{ payload: unknown[]; cached: boolean; fetched_at: string }> {
    // La conexión primero: el caché es por tienda y, sin connection_id, cuál es la
    // tienda lo decide findConnection.
    const conn = await this.requireConnection(clientId, connectionId);

    const { data: row, error } = await supabase
      .from('tiendanube_cache')
      .select('payload, fetched_at, expires_at')
      .eq('connection_id', conn.id)
      .eq('resource', resource)
      .maybeSingle();
    if (error) throw error;

    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return {
        payload: (row.payload as unknown[]) ?? [],
        cached: true,
        fetched_at: row.fetched_at as string,
      };
    }

    // MISS: refetch desde TiendaNube y persistir snapshot.
    const payload = await FETCHERS[resource](conn.store_id, conn.access_token);
    const now = new Date();
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs()).toISOString();

    const { error: upErr } = await supabase.from('tiendanube_cache').upsert(
      {
        client_id: clientId,
        connection_id: conn.id,
        resource,
        payload,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        updated_at: fetchedAt,
      },
      { onConflict: 'connection_id,resource' },
    );
    if (upErr) throw upErr;

    return { payload, cached: false, fetched_at: fetchedAt };
  },
};
