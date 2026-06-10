// Cliente HTTP de bajo nivel para TiendaNube (Nuvemshop).
// OAuth sin refresh: el access_token NO expira. Patrón getCreds() igual que
// unipile-api.service.ts / evolution-api.service.ts.

const TOKEN_URL = 'https://www.tiendanube.com/apps/authorize/token';
const API_BASE = 'https://api.tiendanube.com/v1';

function getCreds(): { appId: string; clientSecret: string; userAgent: string } {
  const appId = process.env.TIENDANUBE_APP_ID;
  const clientSecret = process.env.TIENDANUBE_CLIENT_SECRET;
  const userAgent = process.env.TIENDANUBE_USER_AGENT;
  if (!appId || !clientSecret || !userAgent) {
    throw new Error(
      'TIENDANUBE_APP_ID, TIENDANUBE_CLIENT_SECRET y/o TIENDANUBE_USER_AGENT no configuradas',
    );
  }
  return { appId, clientSecret, userAgent };
}

export type TiendanubeTokenResponse = {
  access_token: string;
  token_type: string;
  scope: string;
  user_id: number; // = store_id
};

/** Datos básicos de la tienda (subset de GET /store). */
export type TiendanubeStore = {
  id: number;
  name?: Record<string, string> | string;
  url_with_protocol?: string;
  original_domain?: string;
  [key: string]: unknown;
};

export const tiendanubeApiService = {
  /** Intercambia el authorization code por un access_token permanente. */
  async exchangeCode(code: string): Promise<TiendanubeTokenResponse> {
    const { appId, clientSecret } = getCreds();
    const body = new URLSearchParams({
      client_id: appId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tiendanube exchangeCode ${res.status}: ${errText}`);
    }

    return (await res.json()) as TiendanubeTokenResponse;
  },

  /** Wrapper genérico contra la API de la tienda. `path` arranca con "/". */
  async request<T = unknown>(
    storeId: number,
    token: string,
    path: string,
  ): Promise<T> {
    const { userAgent } = getCreds();
    const url = `${API_BASE}/${storeId}${path}`;
    const res = await fetch(url, {
      headers: {
        Authentication: `bearer ${token}`,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tiendanube GET ${path} ${res.status}: ${errText}`);
    }

    return (await res.json()) as T;
  },

  /**
   * Igual que request() pero para colecciones paginadas: TiendaNube devuelve 404
   * ("Last page is 0") cuando la colección está vacía o el filtro no matchea, en
   * lugar de un array vacío. Tratamos ese caso como [].
   */
  async requestList(storeId: number, token: string, path: string): Promise<unknown[]> {
    const { userAgent } = getCreds();
    const url = `${API_BASE}/${storeId}${path}`;
    const res = await fetch(url, {
      headers: {
        Authentication: `bearer ${token}`,
        'User-Agent': userAgent,
        'Content-Type': 'application/json',
      },
    });

    if (res.status === 404) return []; // colección vacía
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Tiendanube GET ${path} ${res.status}: ${errText}`);
    }

    return (await res.json()) as unknown[];
  },

  async fetchStore(storeId: number, token: string): Promise<TiendanubeStore> {
    return this.request<TiendanubeStore>(storeId, token, '/store');
  },

  async fetchProducts(storeId: number, token: string): Promise<unknown[]> {
    // Snapshot: primera página amplia. La caché evita pegarle más de 1x/hora.
    // `fields` (sparse fieldsets) excluye imágenes y demás ruido → caché liviano.
    // Precio/promo/stock viven dentro de variants; attributes da los nombres de opción.
    return this.requestList(
      storeId,
      token,
      '/products?per_page=200&published=true&fields=id,name,canonical_url,attributes,variants',
    );
  },

  async fetchOrders(storeId: number, token: string): Promise<unknown[]> {
    return this.requestList(storeId, token, '/orders?per_page=50&sort_by=created_at-descending');
  },

  async fetchCarts(storeId: number, token: string): Promise<unknown[]> {
    // Carritos abandonados. Si el path difiere en tu app, ajustar acá.
    return this.requestList(storeId, token, '/checkouts?per_page=50');
  },
};
