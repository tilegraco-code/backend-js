// Cliente HTTP de bajo nivel para la REST API de WooCommerce (wc/v3).
//
// A diferencia de TiendaNube, no hay un host fijo: cada tienda vive en su propio
// WordPress y la URL la escribe el cliente. Por eso todo request sale por el mismo
// control anti-SSRF que las tools HTTP personalizadas (`safeLookup` valida la IP al
// conectar, sin DNS rebinding) y las redirecciones se siguen a mano, hop por hop.
//
// Auth: claves de la REST API (consumer key / secret) por Basic sobre HTTPS. Algunos
// hostings se comen el header Authorization; para esos se mandan en la query string
// (lo documenta WooCommerce). Sin HTTPS WooCommerce exige OAuth 1.0a firmado: no lo
// soportamos, se pide HTTPS.
import https from 'node:https';
import net from 'node:net';
import { isBlockedAddress, safeLookup } from './http-tool.request';

const TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 8_000_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'Tilegra/1.0 (+https://tilegra.com)';

export class WooError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export type WooAuthMode = 'header' | 'query';

export type WooCreds = {
  storeUrl: string;
  consumerKey: string;
  consumerSecret: string;
  authMode: WooAuthMode;
};

type RawResponse = { status: number; headers: Record<string, string | string[] | undefined>; text: string; url: URL };

// ── URL de la tienda ────────────────────────────────────────────────────────

/**
 * Normaliza lo que tipeó el cliente: agrega https:// si falta, saca query/hash y la
 * barra final. Conserva el path (tiendas instaladas en un subdirectorio, ej. /shop).
 */
export function normalizeStoreUrl(input: string): URL {
  let raw = input.trim();
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WooError('La URL de la tienda no es válida.');
  }
  if (url.protocol === 'http:') {
    throw new WooError(
      'La tienda tiene que estar en HTTPS (WooCommerce no permite usar claves de API sin HTTPS).',
    );
  }
  if (url.protocol !== 'https:') throw new WooError('La URL de la tienda tiene que empezar con https://.');
  if (url.username || url.password) throw new WooError('La URL de la tienda no puede llevar usuario ni contraseña.');
  assertPublicHost(url);
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/(wp-json|wp-admin)(\/.*)?$/, '').replace(/\/+$/, '');
  return url;
}

function assertPublicHost(url: URL): void {
  // Con una IP literal Node no llama a `lookup`, así que safeLookup no la ve.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host)) {
    throw new WooError('Esa URL apunta a una red interna y no está permitida.');
  }
}

/** URL base sin barra final, tal como se guarda en woocommerce_connections.store_url. */
export function baseOf(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// ── Transporte ──────────────────────────────────────────────────────────────

function sendOnce(
  url: URL,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const r = https.request(
      url,
      { method, headers, lookup: safeLookup, timeout: TIMEOUT_MS },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_DOWNLOAD_BYTES) {
            res.destroy(new WooError('La tienda devolvió una respuesta demasiado grande.', 502));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            url,
          }),
        );
        res.on('error', reject);
      },
    );
    r.on('timeout', () => r.destroy(new WooError('La tienda tardó demasiado en responder.', 504)));
    r.on('error', (err: NodeJS.ErrnoException) => {
      if (err instanceof WooError) return reject(err);
      if (err.code === 'EBLOCKED') return reject(new WooError('Esa URL apunta a una red interna y no está permitida.'));
      if (err.code === 'ENOTFOUND') return reject(new WooError(`No existe el dominio ${url.hostname}.`, 400));
      reject(new WooError(`No se pudo conectar con la tienda: ${err.message}`, 502));
    });
    if (body) r.write(body);
    r.end();
  });
}

/**
 * Request con redirecciones seguidas a mano: cada hop pasa de nuevo por safeLookup y
 * por el chequeo de IP literal, así que un 3xx no sirve para llegar a la red interna.
 * Sólo GET sigue redirecciones (un POST redirigido cambia de semántica).
 */
async function send(
  url: URL,
  method: 'GET' | 'POST',
  headers: Record<string, string>,
  body?: string,
): Promise<RawResponse> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await sendOnce(current, method, headers, body);
    const location = res.headers.location;
    if (method !== 'GET' || res.status < 300 || res.status >= 400 || typeof location !== 'string') {
      return res;
    }
    const next = new URL(location, current);
    if (next.protocol !== 'https:') {
      throw new WooError('La tienda redirige a una dirección sin HTTPS.');
    }
    assertPublicHost(next);
    current = next;
  }
  throw new WooError('La tienda redirige demasiadas veces.', 502);
}

function parseJson(res: RawResponse): unknown {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

/** Mensaje de error legible a partir de la respuesta de WooCommerce / WordPress. */
function wooMessage(res: RawResponse): string {
  const data = parseJson(res) as { message?: string; code?: string } | null;
  if (data?.message) return data.message.replace(/<[^>]+>/g, '');
  if (/cloudflare|captcha|challenge/i.test(res.text)) {
    return 'el firewall de la tienda (ej. Cloudflare) bloqueó el pedido';
  }
  return `HTTP ${res.status}`;
}

// ── API autenticada ─────────────────────────────────────────────────────────

type Query = Record<string, string | number | undefined>;

async function call(
  creds: WooCreds,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Query; body?: unknown; namespace?: string } = {},
): Promise<{ data: unknown; res: RawResponse }> {
  const url = new URL(`${creds.storeUrl}/wp-json/${opts.namespace ?? 'wc/v3'}${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
  if (creds.authMode === 'query') {
    url.searchParams.set('consumer_key', creds.consumerKey);
    url.searchParams.set('consumer_secret', creds.consumerSecret);
  } else {
    headers.Authorization = `Basic ${Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64')}`;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await send(url, method, headers, body);
  return { data: parseJson(res), res };
}

async function callOk(
  creds: WooCreds,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: Query; body?: unknown } = {},
): Promise<{ data: unknown; res: RawResponse }> {
  const out = await call(creds, method, path, opts);
  if (out.res.status === 401 || out.res.status === 403) {
    throw new WooError(`WooCommerce rechazó las claves: ${wooMessage(out.res)}.`, 401);
  }
  if (out.res.status >= 400 || out.data === null) {
    throw new WooError(`WooCommerce respondió con error: ${wooMessage(out.res)}.`, 502);
  }
  return out;
}

/** GET que devuelve null en 404 (recurso inexistente) en vez de tirar. */
async function getOrNull(creds: WooCreds, path: string, query?: Query): Promise<unknown | null> {
  const out = await call(creds, 'GET', path, { query });
  if (out.res.status === 404) return null;
  if (out.res.status === 401 || out.res.status === 403) {
    throw new WooError(`WooCommerce rechazó las claves: ${wooMessage(out.res)}.`, 401);
  }
  if (out.res.status >= 400 || out.data === null) {
    throw new WooError(`WooCommerce respondió con error: ${wooMessage(out.res)}.`, 502);
  }
  return out.data;
}

// ── Tipos (subset de lo que usamos) ─────────────────────────────────────────

export type WooProduct = {
  id: number;
  name?: string;
  permalink?: string;
  type?: string; // simple | variable | grouped | external
  status?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string; // instock | outofstock | onbackorder
  manage_stock?: boolean;
  stock_quantity?: number | null;
  purchasable?: boolean;
  short_description?: string;
  categories?: { name?: string }[];
  attributes?: { name?: string; options?: string[] }[];
  variations?: number[];
};

export type WooVariation = {
  id: number;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  manage_stock?: boolean | 'parent';
  stock_quantity?: number | null;
  purchasable?: boolean;
  status?: string;
  attributes?: { name?: string; option?: string }[];
};

export type WooOrderInput = {
  status: 'pending';
  set_paid: false;
  billing: Record<string, string>;
  shipping?: Record<string, string>;
  line_items: { product_id: number; variation_id?: number; quantity: number }[];
  shipping_lines?: { method_id: string; method_title: string; total: string }[];
  customer_note?: string;
  meta_data?: { key: string; value: string }[];
};

export type WooOrder = {
  id: number;
  number?: string;
  status?: string;
  total?: string;
  currency?: string;
  payment_url?: string;
  date_created?: string;
  date_paid?: string | null;
  date_completed?: string | null;
  payment_method_title?: string;
  line_items?: { name?: string; quantity?: number; total?: string }[];
  shipping_lines?: { method_title?: string; total?: string }[];
  shipping?: { city?: string; state?: string; country?: string };
  billing?: { city?: string; state?: string; country?: string; email?: string };
  refunds?: { id: number; reason?: string; total?: string }[];
  // Sólo las claves no protegidas (sin "_" adelante): WooCommerce oculta el resto.
  meta_data?: { key?: string; value?: unknown }[];
  [key: string]: unknown;
};

/** Detalle de un producto (GET /products/<id>): lo de WooProduct + la ficha completa. */
export type WooProductDetail = WooProduct & {
  description?: string;
  sku?: string;
  weight?: string;
  dimensions?: { length?: string; width?: string; height?: string };
  average_rating?: string;
  rating_count?: number;
};

export type WooReview = {
  id: number;
  product_id?: number;
  status?: string;
  reviewer?: string;
  review?: string;
  rating?: number;
  verified?: boolean;
  date_created?: string;
};

export type WooShippingZone = { id: number; name?: string; order?: number };
export type WooZoneLocation = { code: string; type: 'postcode' | 'state' | 'country' | 'continent' };
export type WooZoneMethod = {
  instance_id?: number;
  title?: string;
  enabled?: boolean;
  method_id?: string; // flat_rate | free_shipping | local_pickup | <plugin>
  method_title?: string;
  settings?: Record<string, { value?: unknown }>;
};

export type WooPaymentGateway = {
  id: string;
  title?: string;
  description?: string;
  enabled?: boolean;
  order?: number | string;
};

export type WooCountry = { code: string; name?: string; states?: { code: string; name: string }[] };

export type WooShipmentTracking = {
  tracking_id?: string;
  tracking_provider?: string;
  tracking_number?: string;
  tracking_link?: string;
  date_shipped?: string;
};

export type WooOrderNote = { id: number; note?: string; customer_note?: boolean; date_created?: string };

const PRODUCT_FIELDS =
  'id,name,permalink,type,status,price,regular_price,sale_price,stock_status,manage_stock,stock_quantity,purchasable,short_description,categories,attributes,variations';
const VARIATION_FIELDS =
  'id,price,regular_price,sale_price,stock_status,manage_stock,stock_quantity,purchasable,status,attributes';
const PER_PAGE = 100;
const MAX_PAGES = 20; // tope de 2000 productos por tienda

export const woocommerceApiService = {
  /**
   * Verifica que en esa URL haya un WordPress con WooCommerce y devuelve la URL base
   * final (después de redirecciones, ej. sin www → con www) y el nombre del sitio.
   * No usa claves: el índice de la REST API (/wp-json/) es público.
   */
  async discoverStore(input: string): Promise<{ storeUrl: string; name: string | null }> {
    const start = normalizeStoreUrl(input);
    const res = await send(new URL(`${baseOf(start)}/wp-json/`), 'GET', {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    });
    const data = parseJson(res) as { name?: string; namespaces?: string[] } | null;

    if (res.status === 404 || (res.status < 400 && !data)) {
      throw new WooError(
        'No encontramos la API de WordPress en esa URL. Revisá la dirección y que en WordPress → Ajustes → Enlaces permanentes no esté elegido "Simple".',
      );
    }
    if (res.status >= 400 || !data) {
      throw new WooError(`La tienda no respondió bien (${wooMessage(res)}).`, 502);
    }
    if (!data.namespaces?.includes('wc/v3')) {
      throw new WooError('Esa web es un WordPress pero no tiene WooCommerce activo (o la REST API está desactivada).');
    }

    // La URL final del hop que respondió, menos /wp-json/.
    const finalBase = new URL(res.url);
    finalBase.pathname = finalBase.pathname.replace(/\/wp-json\/?$/, '');
    finalBase.search = '';
    return { storeUrl: baseOf(finalBase), name: data.name?.trim() || null };
  },

  /**
   * Valida las claves y decide el modo de auth: primero header Basic; si la tienda
   * lo rechaza, prueba por query string (hostings que se comen el header).
   */
  async validateKeys(
    storeUrl: string,
    consumerKey: string,
    consumerSecret: string,
  ): Promise<{ authMode: WooAuthMode; currency: string | null }> {
    let lastError = '';
    for (const authMode of ['header', 'query'] as const) {
      const creds = { storeUrl, consumerKey, consumerSecret, authMode };
      const { data, res } = await call(creds, 'GET', '/data/currencies/current');
      if (res.status < 400 && data) {
        return { authMode, currency: (data as { code?: string }).code ?? null };
      }
      lastError = wooMessage(res);
      if (res.status !== 401 && res.status !== 403) break;
    }
    throw new WooError(`WooCommerce rechazó las claves (${lastError}). Revisá que estén bien copiadas.`, 400);
  },

  /**
   * ¿Las claves pueden escribir? Mandamos un pedido con un estado inválido: con
   * permiso de escritura WooCommerce lo rechaza por validación (400) sin crear
   * nada; con claves de sólo lectura lo rechaza la autenticación (401).
   */
  async canWrite(creds: WooCreds): Promise<boolean> {
    const { res } = await call(creds, 'POST', '/orders', { body: { status: '__tilegra_probe__' } });
    return res.status !== 401 && res.status !== 403;
  },

  async fetchCurrency(creds: WooCreds): Promise<string | null> {
    const { data } = await callOk(creds, 'GET', '/data/currencies/current');
    return (data as { code?: string }).code ?? null;
  },

  /** Catálogo publicado, paginado (hasta MAX_PAGES páginas). */
  async fetchProducts(creds: WooCreds): Promise<WooProduct[]> {
    const all: WooProduct[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const { data, res } = await callOk(creds, 'GET', '/products', {
        query: { per_page: PER_PAGE, page, status: 'publish', _fields: PRODUCT_FIELDS },
      });
      const items = (data as WooProduct[]) ?? [];
      all.push(...items);
      const totalPages = Number(res.headers['x-wp-totalpages'] ?? 1);
      if (items.length < PER_PAGE || page >= totalPages) break;
    }
    return all;
  },

  async fetchVariations(creds: WooCreds, productId: number): Promise<WooVariation[]> {
    const { data } = await callOk(creds, 'GET', `/products/${productId}/variations`, {
      query: { per_page: PER_PAGE, _fields: VARIATION_FIELDS },
    });
    return (data as WooVariation[]) ?? [];
  },

  /** Ficha completa de un producto. null si no existe. */
  async fetchProduct(creds: WooCreds, productId: number): Promise<WooProductDetail | null> {
    return (await getOrNull(creds, `/products/${productId}`)) as WooProductDetail | null;
  },

  /** Reseñas aprobadas de un producto, las más nuevas primero. */
  async fetchReviews(creds: WooCreds, productId: number, limit = 10): Promise<WooReview[]> {
    const { data } = await callOk(creds, 'GET', '/products/reviews', {
      query: { product: productId, status: 'approved', per_page: limit, orderby: 'date_gmt', order: 'desc' },
    });
    return (data as WooReview[]) ?? [];
  },

  async fetchShippingZones(creds: WooCreds): Promise<WooShippingZone[]> {
    const { data } = await callOk(creds, 'GET', '/shipping/zones');
    return (data as WooShippingZone[]) ?? [];
  },

  async fetchZoneLocations(creds: WooCreds, zoneId: number): Promise<WooZoneLocation[]> {
    const { data } = await callOk(creds, 'GET', `/shipping/zones/${zoneId}/locations`);
    return (data as WooZoneLocation[]) ?? [];
  },

  async fetchZoneMethods(creds: WooCreds, zoneId: number): Promise<WooZoneMethod[]> {
    const { data } = await callOk(creds, 'GET', `/shipping/zones/${zoneId}/methods`);
    return (data as WooZoneMethod[]) ?? [];
  },

  async fetchPaymentGateways(creds: WooCreds): Promise<WooPaymentGateway[]> {
    const { data } = await callOk(creds, 'GET', '/payment_gateways');
    return (data as WooPaymentGateway[]) ?? [];
  },

  /** País con sus provincias (para pasar "Córdoba" → "AR:X"). null si no existe. */
  async fetchCountry(creds: WooCreds, code: string): Promise<WooCountry | null> {
    return (await getOrNull(creds, `/data/countries/${encodeURIComponent(code.toLowerCase())}`)) as WooCountry | null;
  },

  /** País/provincia base de la tienda (ajuste woocommerce_default_country, ej. "AR:C"). */
  async fetchStoreCountry(creds: WooCreds): Promise<string | null> {
    const data = (await getOrNull(creds, '/settings/general/woocommerce_default_country')) as { value?: string } | null;
    return data?.value ?? null;
  },

  async fetchOrder(creds: WooCreds, orderId: number): Promise<WooOrder | null> {
    return (await getOrNull(creds, `/orders/${orderId}`)) as WooOrder | null;
  },

  /** Búsqueda libre de pedidos, los más nuevos primero (por número de plugin o por email). */
  async searchOrders(creds: WooCreds, term: string, perPage = 20): Promise<WooOrder[]> {
    const { data } = await callOk(creds, 'GET', '/orders', {
      query: { search: term, per_page: perPage, orderby: 'date', order: 'desc' },
    });
    return (data as WooOrder[]) ?? [];
  },

  /**
   * Seguimiento del envío cargado con los plugins "Shipment Tracking" (oficial) o
   * "Advanced Shipment Tracking" (AST): los dos exponen este endpoint con las mismas
   * claves. WooCommerce no trae seguimiento de fábrica: sin plugin la ruta no existe
   * (404) y devolvemos []. Un error acá nunca debe tirar la consulta del pedido.
   */
  async fetchShipmentTrackings(creds: WooCreds, orderId: number): Promise<WooShipmentTracking[]> {
    try {
      const { data, res } = await call(creds, 'GET', `/orders/${orderId}/shipment-trackings`, {
        namespace: 'wc-shipment-tracking/v3',
      });
      return res.status < 400 && Array.isArray(data) ? (data as WooShipmentTracking[]) : [];
    } catch {
      return [];
    }
  },

  /** Sólo las notas que la tienda marcó para el cliente (las internas nunca salen). */
  async fetchCustomerNotes(creds: WooCreds, orderId: number): Promise<WooOrderNote[]> {
    const { data } = await callOk(creds, 'GET', `/orders/${orderId}/notes`, { query: { type: 'customer' } });
    return ((data as WooOrderNote[]) ?? []).filter((n) => n.customer_note !== false);
  },

  async createOrder(creds: WooCreds, input: WooOrderInput): Promise<WooOrder> {
    const { data, res } = await call(creds, 'POST', '/orders', { body: input });
    if (res.status === 401 || res.status === 403) {
      throw new WooError(
        'Las claves de WooCommerce no tienen permiso de escritura. Reconectá la tienda con permisos de Lectura/Escritura.',
        401,
      );
    }
    if (res.status >= 400 || !data) {
      throw new WooError(`WooCommerce no pudo crear el pedido: ${wooMessage(res)}.`, 400);
    }
    return data as WooOrder;
  },
};
