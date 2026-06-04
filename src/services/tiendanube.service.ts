// Conexión + caché read-through de TiendaNube.
// - Conexión: tabla tiendanube_connections (1 fila por client_id).
// - Caché: tabla tiendanube_cache (snapshot JSON por (client_id, resource), TTL 1h).
import { supabase } from '../lib/supabase';
import { tiendanubeApiService, TiendanubeStore } from './tiendanube-api.service';

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
