// Conexión + caché read-through de TiendaNube.
// - Conexión: tabla tiendanube_connections (1 fila por client_id).
// - Caché: tabla tiendanube_cache (snapshot JSON por (client_id, resource), TTL 1h).
import { supabase } from '../lib/supabase';
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

// Caché en memoria de la moneda por cliente. La moneda casi nunca cambia, así que
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
  async getConnection(clientId: number): Promise<TiendanubeConnection | null> {
    const { data, error } = await supabase
      .from('tiendanube_connections')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    return (data as TiendanubeConnection | null) ?? null;
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
      { onConflict: 'client_id' },
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
  async getCurrency(clientId: number): Promise<string | null> {
    const hit = currencyCache.get(clientId);
    if (hit && Date.now() - hit.ts < CURRENCY_TTL_MS) return hit.currency;

    const conn = await this.getConnection(clientId);
    if (!conn) return null;

    let currency: string | null = null;
    try {
      const store = await tiendanubeApiService.fetchStore(conn.store_id, conn.access_token);
      currency = pickCurrency(store);
    } catch {
      currency = null;
    }

    currencyCache.set(clientId, { currency, ts: Date.now() });
    return currency;
  },

  /**
   * Crea un draft order en la tienda del cliente y devuelve el checkout_url
   * listo para pagar. El cliente coordina envío y descuentos en el checkout.
   */
  async createCheckout(
    clientId: number,
    input: CreateCheckoutInput,
  ): Promise<CreateCheckoutResult> {
    const conn = await this.getConnection(clientId);
    if (!conn) {
      throw new Error('Este workspace no tiene TiendaNube conectado');
    }
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
      currency: await this.getCurrency(clientId),
    };
  },

  /**
   * Núcleo del caché read-through. Devuelve el snapshot del recurso: HIT si
   * está fresco (expires_at > now), MISS si no (refetch + upsert).
   */
  async getCachedResource(
    clientId: number,
    resource: TiendanubeResource,
  ): Promise<{ payload: unknown[]; cached: boolean; fetched_at: string }> {
    const { data: row, error } = await supabase
      .from('tiendanube_cache')
      .select('payload, fetched_at, expires_at')
      .eq('client_id', clientId)
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
    const conn = await this.getConnection(clientId);
    if (!conn) {
      throw new Error('Este workspace no tiene TiendaNube conectado');
    }

    const payload = await FETCHERS[resource](conn.store_id, conn.access_token);
    const now = new Date();
    const fetchedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs()).toISOString();

    const { error: upErr } = await supabase.from('tiendanube_cache').upsert(
      {
        client_id: clientId,
        resource,
        payload,
        fetched_at: fetchedAt,
        expires_at: expiresAt,
        updated_at: fetchedAt,
      },
      { onConflict: 'client_id,resource' },
    );
    if (upErr) throw upErr;

    return { payload, cached: false, fetched_at: fetchedAt };
  },
};
