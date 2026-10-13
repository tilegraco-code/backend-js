// Conexión + lecturas para el agente + armado de pedidos de WooCommerce.
// - Conexión: tabla woocommerce_connections (1 fila por client_id).
// - Caché: tabla woocommerce_cache (TTL 1h) para lo que cambia poco y cuesta varios
//   requests: catálogo (1 por página + 1 por producto variable), configuración de
//   envíos y medios de pago. Detalle de producto, reseñas y pedidos van en vivo.
// - Checkout: crea un pedido `pending` y devuelve su payment_url (la página de
//   WooCommerce para pagar ese pedido). El envío lo define la config de la tool.
import { supabase } from '../lib/supabase';
import { signState } from '../lib/oauth-state';
import { filterByQuery } from '../lib/text-search';
import { WooCountry, WooCreds, WooError, WooOrderInput, woocommerceApiService } from './woocommerce-api.service';
import {
  ShapedProduct,
  ZoneWithRules,
  matchShippingZone,
  resolveStateCode,
  shapeOrderStatus,
  shapeProduct,
  shapeProductDetail,
  shapeReview,
  shapeShippingMethod,
} from './woocommerce.shape';

export type WoocommerceConnection = {
  id: number;
  client_id: number;
  store_url: string;
  consumer_key: string;
  consumer_secret: string;
  auth_mode: 'header' | 'query';
  key_permissions: string | null;
  store_name: string | null;
  currency: string | null;
  connected_at: string;
};

/** Config de la tool `create_checkout` (la completa el cliente en el dashboard). */
export type WoocommerceCheckoutConfig = {
  // none = el pedido sale sin envío (retiro en local / se coordina aparte).
  // flat = se suma un envío de costo fijo y el agente pide la dirección.
  shipping_mode?: 'none' | 'flat';
  shipping_title?: string;
  shipping_cost?: number;
};

export type WoocommerceCheckoutInput = {
  name: string;
  lastname?: string;
  email: string;
  phone?: string;
  address?: {
    address_1?: string;
    address_2?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
  products: { product_id: number; variation_id?: number; quantity: number }[];
  note?: string;
};

/** Ventana para completar el flujo de autorización (incluye loguearse en WordPress). */
export const AUTHORIZE_STATE_MAX_AGE_MS = 30 * 60_000;

const MAX_SEARCH_RESULTS = 30;
const VARIATION_CONCURRENCY = 5;

function ttlMs(): number {
  const minutes = Number(process.env.WOOCOMMERCE_CACHE_TTL_MINUTES ?? 60);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 60) * 60_000;
}

function credsOf(conn: WoocommerceConnection): WooCreds {
  return {
    storeUrl: conn.store_url,
    consumerKey: conn.consumer_key,
    consumerSecret: conn.consumer_secret,
    authMode: conn.auth_mode,
  };
}

/** map con concurrencia acotada (no tirarle 200 requests juntos al WordPress). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (it: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchShapedCatalog(creds: WooCreds): Promise<ShapedProduct[]> {
  const products = await woocommerceApiService.fetchProducts(creds);
  return mapLimit(products, VARIATION_CONCURRENCY, async (p) => {
    const variations =
      p.type === 'variable' && (p.variations?.length ?? 0) > 0
        ? await woocommerceApiService.fetchVariations(creds, p.id)
        : [];
    return shapeProduct(p, variations);
  });
}

// Dos conversaciones que leen el mismo recurso con el caché vencido comparten el refetch.
const inflight = new Map<string, Promise<unknown>>();

function stripTags(html: string | undefined): string | null {
  const text = (html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 300) : null;
}

function countCategories(items: ShapedProduct[]): { name: string; products: number }[] {
  const counts = new Map<string, number>();
  for (const p of items) for (const c of p.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, products]) => ({ name, products }));
}

type ShippingSetup = {
  store_country: string | null;
  zones: ZoneWithRules[];
  // Países que aparecen en las zonas (+ el de la tienda), con sus provincias.
  countries: Record<string, WooCountry>;
};

async function fetchShippingSetup(creds: WooCreds): Promise<ShippingSetup> {
  const [zones, storeCountry] = await Promise.all([
    woocommerceApiService.fetchShippingZones(creds),
    woocommerceApiService.fetchStoreCountry(creds).catch(() => null),
  ]);
  const withRules = await mapLimit(zones, VARIATION_CONCURRENCY, async (z) => {
    const [locations, methods] = await Promise.all([
      z.id === 0 ? Promise.resolve([]) : woocommerceApiService.fetchZoneLocations(creds, z.id),
      woocommerceApiService.fetchZoneMethods(creds, z.id),
    ]);
    return {
      id: z.id,
      name: z.name ?? '',
      order: z.order ?? 0,
      locations,
      // Sólo lo que usa shapeShippingMethod (los settings traen mucho ruido de UI).
      methods: methods.map((m) => ({
        instance_id: m.instance_id,
        title: m.title,
        enabled: m.enabled,
        method_id: m.method_id,
        method_title: m.method_title,
        settings: Object.fromEntries(
          ['title', 'cost', 'requires', 'min_amount']
            .filter((k) => m.settings?.[k])
            .map((k) => [k, { value: m.settings![k].value }]),
        ),
      })),
    };
  });

  const store = storeCountry?.split(':')[0]?.toUpperCase() || null;
  const codes = new Set<string>(store ? [store] : []);
  for (const z of withRules) {
    for (const l of z.locations) {
      if (l.type === 'country' || l.type === 'state') codes.add(l.code.split(':')[0].toUpperCase());
    }
  }
  const countries: Record<string, WooCountry> = {};
  for (const code of codes) {
    const c = await woocommerceApiService.fetchCountry(creds, code).catch(() => null);
    if (c) countries[code] = { code: c.code, name: c.name, states: c.states ?? [] };
  }
  return { store_country: store, zones: withRules, countries };
}

export const woocommerceService = {
  async getConnection(clientId: number): Promise<WoocommerceConnection | null> {
    const { data, error } = await supabase
      .from('woocommerce_connections')
      .select('*')
      .eq('client_id', clientId)
      .maybeSingle();
    if (error) throw error;
    return (data as WoocommerceConnection | null) ?? null;
  },

  /**
   * Arma la URL del flujo de autorización de WooCommerce (/wc-auth/v1/authorize).
   * La tienda le manda las claves por POST a nuestro callback; el `user_id` es el
   * state firmado (client_id + URL de la tienda), que es lo que nos devuelve.
   */
  async buildAuthorizeUrl(clientId: number, rawStoreUrl: string): Promise<{ authorize_url: string; store_url: string }> {
    const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/$/, '');
    const dashboardUrl = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
    if (!publicUrl.startsWith('https://') || !dashboardUrl) {
      // WooCommerce exige un callback_url HTTPS.
      throw new WooError('La conexión automática no está disponible (PUBLIC_URL / DASHBOARD_URL). Cargá las claves a mano.', 500);
    }

    const { storeUrl } = await woocommerceApiService.discoverStore(rawStoreUrl);
    const state = signState(clientId, { store_url: storeUrl });
    const params = new URLSearchParams({
      app_name: 'Tilegra',
      scope: 'read_write',
      user_id: state,
      return_url: `${dashboardUrl}/dashboard/integrations?woocommerce=return`,
      callback_url: `${publicUrl}/api/woocommerce/oauth/callback`,
    });
    return { authorize_url: `${storeUrl}/wc-auth/v1/authorize?${params}`, store_url: storeUrl };
  },

  /**
   * Valida las claves contra la tienda y guarda la conexión. `rawStoreUrl` puede venir
   * tipeada por el cliente (conexión manual): se normaliza y se resuelve igual que en el
   * flujo automático. Lanza WooError si la tienda o las claves no sirven.
   */
  async saveConnection(input: {
    clientId: number;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
    keyPermissions?: string | null;
  }): Promise<{ store_url: string; store_name: string | null; can_write: boolean }> {
    const { storeUrl, name } = await woocommerceApiService.discoverStore(input.storeUrl);
    const consumerKey = input.consumerKey.trim();
    const consumerSecret = input.consumerSecret.trim();
    const { authMode, currency } = await woocommerceApiService.validateKeys(storeUrl, consumerKey, consumerSecret);

    // El flujo automático informa los permisos; con claves pegadas a mano los probamos.
    let permissions = input.keyPermissions ?? null;
    if (!permissions) {
      const canWrite = await woocommerceApiService.canWrite({ storeUrl, consumerKey, consumerSecret, authMode });
      permissions = canWrite ? 'read_write' : 'read';
    }

    const now = new Date().toISOString();
    const { error } = await supabase.from('woocommerce_connections').upsert(
      {
        client_id: input.clientId,
        store_url: storeUrl,
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
        auth_mode: authMode,
        key_permissions: permissions,
        store_name: name,
        currency,
        connected_at: now,
        updated_at: now,
      },
      { onConflict: 'client_id' },
    );
    if (error) throw error;

    // Puede ser otra tienda: el catálogo cacheado ya no vale.
    await supabase.from('woocommerce_cache').delete().eq('client_id', input.clientId);

    return { store_url: storeUrl, store_name: name, can_write: permissions.includes('write') };
  },

  /**
   * Guarda las claves que mandó el flujo de autorización SIN pegarle a la tienda:
   * WooCommerce está esperando nuestra respuesta dentro del mismo request de PHP, y
   * en hostings chicos (1 worker) un request nuestro a la tienda se quedaría colgado.
   * La URL viene del state firmado (ya pasó por discoverStore). El modo de auth, la
   * moneda y el nombre se completan después con `refreshConnectionInfo`.
   */
  async saveFromAuthorize(input: {
    clientId: number;
    storeUrl: string;
    consumerKey: string;
    consumerSecret: string;
    keyPermissions: string | null;
  }): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await supabase.from('woocommerce_connections').upsert(
      {
        client_id: input.clientId,
        store_url: input.storeUrl,
        consumer_key: input.consumerKey.trim(),
        consumer_secret: input.consumerSecret.trim(),
        auth_mode: 'header',
        key_permissions: input.keyPermissions ?? 'read_write',
        connected_at: now,
        updated_at: now,
      },
      { onConflict: 'client_id' },
    );
    if (error) throw error;
    await supabase.from('woocommerce_cache').delete().eq('client_id', input.clientId);
  },

  /** Valida las claves guardadas y completa auth_mode / moneda / nombre de la tienda. */
  async refreshConnectionInfo(clientId: number): Promise<void> {
    const conn = await this.getConnection(clientId);
    if (!conn) return;
    const [{ authMode, currency }, store] = await Promise.all([
      woocommerceApiService.validateKeys(conn.store_url, conn.consumer_key, conn.consumer_secret),
      woocommerceApiService.discoverStore(conn.store_url).catch(() => null),
    ]);
    const { error } = await supabase
      .from('woocommerce_connections')
      .update({
        auth_mode: authMode,
        currency,
        ...(store?.name ? { store_name: store.name } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq('client_id', clientId);
    if (error) throw error;
  },

  async deleteConnection(clientId: number): Promise<void> {
    const { error } = await supabase.from('woocommerce_connections').delete().eq('client_id', clientId);
    if (error) throw error;
    await supabase.from('woocommerce_cache').delete().eq('client_id', clientId);
  },

  /** Conexión o error claro para el agente. */
  async requireConnection(clientId: number): Promise<WoocommerceConnection> {
    const conn = await this.getConnection(clientId);
    if (!conn) throw new WooError('Este workspace no tiene WooCommerce conectado', 404);
    return conn;
  },

  /**
   * Read-through sobre woocommerce_cache: devuelve el snapshot de `resource` si está
   * fresco; si no, lo recalcula con `fetcher` y lo guarda. Pedidos concurrentes del
   * mismo recurso comparten el mismo refetch.
   */
  async cached<T>(
    clientId: number,
    resource: string,
    fetcher: () => Promise<T>,
  ): Promise<{ payload: T; cached: boolean; fetched_at: string }> {
    const { data: row, error } = await supabase
      .from('woocommerce_cache')
      .select('payload, fetched_at, expires_at')
      .eq('client_id', clientId)
      .eq('resource', resource)
      .maybeSingle();
    if (error) throw error;
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { payload: row.payload as T, cached: true, fetched_at: row.fetched_at as string };
    }

    const key = `${clientId}:${resource}`;
    let pending = inflight.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = fetcher().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    const payload = await pending;

    const now = new Date();
    const fetchedAt = now.toISOString();
    const { error: upErr } = await supabase.from('woocommerce_cache').upsert(
      {
        client_id: clientId,
        resource,
        payload,
        fetched_at: fetchedAt,
        expires_at: new Date(now.getTime() + ttlMs()).toISOString(),
        updated_at: fetchedAt,
      },
      { onConflict: 'client_id,resource' },
    );
    if (upErr) throw upErr;
    return { payload, cached: false, fetched_at: fetchedAt };
  },

  /** Catálogo compactado (cacheado). */
  async getProducts(clientId: number): Promise<{ items: ShapedProduct[]; cached: boolean; fetched_at: string; currency: string | null }> {
    const conn = await this.requireConnection(clientId);
    const { payload, cached, fetched_at } = await this.cached(clientId, 'products', () =>
      fetchShapedCatalog(credsOf(conn)),
    );
    return { items: payload ?? [], cached, fetched_at, currency: conn.currency };
  },

  /**
   * Lo que ve el agente al buscar: filtrado por texto y acotado para no inflar el prompt.
   * Sin texto suma las categorías, para que el agente pueda contar qué vende la tienda.
   */
  async searchProducts(clientId: number, query?: string) {
    const { items, cached, fetched_at, currency } = await this.getProducts(clientId);
    const matches = filterByQuery(items, query);
    const categories = query?.trim() ? null : countCategories(items);
    return {
      items: matches.slice(0, MAX_SEARCH_RESULTS),
      count: matches.length,
      ...(matches.length > MAX_SEARCH_RESULTS
        ? { note: `Hay ${matches.length} resultados; se muestran los primeros ${MAX_SEARCH_RESULTS}. Buscá algo más específico.` }
        : {}),
      ...(categories ? { categories } : {}),
      currency,
      cached,
      fetched_at,
    };
  },

  /** Ficha completa de un producto, en vivo (precio y stock al momento). */
  async getProductDetail(clientId: number, productId: number) {
    const conn = await this.requireConnection(clientId);
    const creds = credsOf(conn);
    const product = await woocommerceApiService.fetchProduct(creds, productId);
    if (!product || (product.status && product.status !== 'publish')) {
      return { found: false, reason: `No existe un producto publicado con product_id ${productId}.` };
    }
    const variations =
      product.type === 'variable' && (product.variations?.length ?? 0) > 0
        ? await woocommerceApiService.fetchVariations(creds, product.id)
        : [];
    return { found: true, currency: conn.currency, ...shapeProductDetail(product, variations) };
  },

  /** Últimas reseñas aprobadas de un producto. */
  async getReviews(clientId: number, productId: number) {
    const conn = await this.requireConnection(clientId);
    const reviews = await woocommerceApiService.fetchReviews(credsOf(conn), productId);
    if (reviews.length === 0) {
      return { product_id: productId, count: 0, reviews: [], note: 'Este producto todavía no tiene reseñas.' };
    }
    const ratings = reviews.map((r) => r.rating ?? 0).filter((n) => n > 0);
    const average = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) / 10 : null;
    return { product_id: productId, count: reviews.length, average_of_shown: average, reviews: reviews.map(shapeReview) };
  },

  /**
   * Opciones de envío para un destino. Zonas, ubicaciones y métodos se cachean juntos
   * (cambian poco y son 1 + 2×zonas requests). La provincia se acepta por nombre.
   */
  async getShippingOptions(clientId: number, input: { country?: string; state?: string; postcode?: string }) {
    const conn = await this.requireConnection(clientId);
    const creds = credsOf(conn);
    const { payload } = await this.cached(clientId, 'shipping', () => fetchShippingSetup(creds));

    const country = (input.country?.trim() || payload.store_country || '').toUpperCase().slice(0, 2);
    if (!country) {
      return { found: false, reason: 'Necesito saber el país de destino (código de 2 letras, ej. AR).' };
    }
    const countryData = payload.countries[country] ?? null;
    const stateCode = resolveStateCode(countryData, input.state);
    if (input.state?.trim() && !stateCode) {
      const options = countryData?.states?.map((st) => st.name).join(', ');
      return {
        found: false,
        reason: `No reconozco la provincia "${input.state}".${options ? ` Opciones: ${options}.` : ''}`,
      };
    }

    const zone = matchShippingZone(payload.zones, { country, state: stateCode, postcode: input.postcode });
    if (zone === 'needs_state') {
      return { found: false, reason: 'El costo depende de la provincia: preguntale al comprador a qué provincia es el envío.' };
    }
    if (zone === 'needs_postcode') {
      return { found: false, reason: 'El costo depende del código postal: preguntale al comprador su código postal.' };
    }
    const methods = (zone?.methods ?? []).filter((m) => m.enabled !== false);
    if (!zone || methods.length === 0) {
      return { found: true, ships: false, reason: 'La tienda no tiene envíos configurados para ese destino.' };
    }
    return {
      found: true,
      ships: true,
      zone: zone.name,
      currency: conn.currency,
      methods: methods.map(shapeShippingMethod),
    };
  },

  /** Medios de pago activos (cacheado). */
  async getPaymentMethods(clientId: number) {
    const conn = await this.requireConnection(clientId);
    const { payload } = await this.cached(clientId, 'payment_methods', async () => {
      const gateways = await woocommerceApiService.fetchPaymentGateways(credsOf(conn));
      return gateways
        .filter((g) => g.enabled)
        .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0))
        .map((g) => ({ name: g.title || g.id, description: stripTags(g.description) }));
    });
    return payload.length
      ? { methods: payload }
      : { methods: [], note: 'La tienda no tiene medios de pago activos.' };
  },

  /**
   * Estado de un pedido por número. Sin verificación de identidad (decisión de producto),
   * por eso shapeOrderStatus no devuelve datos personales.
   *
   * El número que ve el comprador puede no ser el id interno (plugins de numeración
   * secuencial): sólo aceptamos un pedido cuyo `number` coincida exactamente.
   */
  async getOrderStatus(clientId: number, rawNumber: string) {
    const conn = await this.requireConnection(clientId);
    const creds = credsOf(conn);
    const needle = rawNumber.trim().replace(/^#/, '');
    if (!needle) return { found: false, reason: 'No me pasaste un número de pedido.' };

    let order = /^\d+$/.test(needle) ? await woocommerceApiService.fetchOrder(creds, Number(needle)) : null;
    if (order && String(order.number ?? order.id) !== needle) order = null;
    if (!order) {
      const results = await woocommerceApiService.searchOrders(creds, needle);
      order = results.find((o) => String(o.number ?? o.id) === needle) ?? null;
    }
    if (!order || order.status === 'trash') {
      return {
        found: false,
        reason: `No encontré ningún pedido con el número ${needle}. Pedile al comprador que revise el número en el mail de confirmación de la compra.`,
      };
    }
    const notes = await woocommerceApiService.fetchCustomerNotes(creds, order.id).catch(() => []);
    return shapeOrderStatus(order, notes);
  },

  /** Lee la config de la tool verificando que sea de WooCommerce y de este cliente. */
  async loadCheckoutConfig(toolId: number, clientId: number): Promise<WoocommerceCheckoutConfig> {
    const { data, error } = await supabase
      .from('agent_tools')
      .select('type, config, agent:agent_id(project:project_id(client_id))')
      .eq('id', toolId)
      .maybeSingle();
    if (error) throw error;
    const owner = (data?.agent as unknown as { project?: { client_id?: number } } | null)?.project?.client_id;
    if (!data || owner !== clientId || data.type !== 'woocommerce') {
      throw new WooError('Herramienta no encontrada.', 404);
    }
    return (data.config as WoocommerceCheckoutConfig | null) ?? {};
  },

  /**
   * Crea un pedido pendiente de pago y devuelve el link para pagarlo. WooCommerce
   * calcula precios e impuestos con los valores actuales de la tienda.
   */
  async createCheckout(clientId: number, toolId: number, input: WoocommerceCheckoutInput) {
    const conn = await this.getConnection(clientId);
    if (!conn) throw new WooError('Este workspace no tiene WooCommerce conectado', 404);
    if (conn.key_permissions && !conn.key_permissions.includes('write')) {
      throw new WooError(
        'Las claves de WooCommerce son de sólo lectura. Reconectá la tienda con permisos de Lectura/Escritura.',
      );
    }
    if (!input.products?.length) {
      throw new WooError('Se requiere al menos un producto (product_id + quantity).');
    }

    const config = await this.loadCheckoutConfig(toolId, clientId);

    // Un producto variable sin variation_id genera una línea sin talle/color: cortar
    // acá con un mensaje que el agente entienda. Si el producto no está en el catálogo
    // cacheado (recién creado) dejamos que WooCommerce decida.
    const { items: catalog } = await this.getProducts(clientId).catch(() => ({ items: [] as ShapedProduct[] }));
    const byId = new Map(catalog.map((p) => [p.product_id, p]));
    for (const line of input.products) {
      const p = byId.get(line.product_id);
      if (!p) continue;
      if (!p.purchasable) throw new WooError(`"${p.name}" no se puede comprar online.`);
      if (p.variants && !line.variation_id) {
        const opts = p.variants.map((v) => `${v.variation_id} (${v.options.join(', ')})`).join('; ');
        throw new WooError(`"${p.name}" tiene variantes: indicá el variation_id elegido. Opciones: ${opts}`);
      }
    }

    const address = input.address ?? {};
    const shippingMode = config.shipping_mode ?? 'none';
    if (shippingMode === 'flat' && (!address.address_1?.trim() || !address.city?.trim())) {
      throw new WooError(
        'Falta la dirección de envío: pedile al comprador calle y número, ciudad, provincia y código postal, y mandalos en "address".',
      );
    }

    const contact = {
      first_name: input.name.trim(),
      last_name: input.lastname?.trim() ?? '',
    };
    const addr: Record<string, string> = Object.fromEntries(
      Object.entries(address).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()]),
    );
    const order: WooOrderInput = {
      status: 'pending',
      set_paid: false,
      billing: {
        ...contact,
        ...addr,
        email: input.email.trim(),
        ...(input.phone ? { phone: input.phone.trim() } : {}),
      },
      ...(shippingMode === 'flat' ? { shipping: { ...contact, ...addr } } : {}),
      line_items: input.products.map((p) => ({
        product_id: p.product_id,
        ...(p.variation_id ? { variation_id: p.variation_id } : {}),
        quantity: p.quantity,
      })),
      ...(shippingMode === 'flat'
        ? {
            shipping_lines: [
              {
                method_id: 'flat_rate',
                method_title: config.shipping_title?.trim() || 'Envío',
                total: (config.shipping_cost ?? 0).toFixed(2),
              },
            ],
          }
        : {}),
      ...(input.note ? { customer_note: input.note } : {}),
      meta_data: [{ key: '_tilegra_agent_order', value: '1' }],
    };

    const created = await woocommerceApiService.createOrder(credsOf(conn), order);
    return {
      payment_url: created.payment_url ?? null,
      order_id: created.id,
      order_number: created.number ?? String(created.id),
      total: created.total ?? null,
      currency: created.currency ?? conn.currency,
      shipping:
        shippingMode === 'flat'
          ? { title: config.shipping_title?.trim() || 'Envío', cost: config.shipping_cost ?? 0 }
          : null,
    };
  },
};
