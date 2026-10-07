// Conexión + catálogo cacheado + armado de pedidos de WooCommerce.
// - Conexión: tabla woocommerce_connections (1 fila por client_id).
// - Caché: tabla woocommerce_cache (catálogo ya compactado, TTL 1h). Bajar el
//   catálogo cuesta 1 request por página + 1 por cada producto variable.
// - Checkout: crea un pedido `pending` y devuelve su payment_url (la página de
//   WooCommerce para pagar ese pedido). El envío lo define la config de la tool.
import { supabase } from '../lib/supabase';
import { signState } from '../lib/oauth-state';
import { filterByQuery } from '../lib/text-search';
import { WooCreds, WooError, WooOrderInput, woocommerceApiService } from './woocommerce-api.service';
import { ShapedProduct, shapeProduct } from './woocommerce.shape';

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

// Dos conversaciones que buscan a la vez con el caché vencido comparten el mismo refetch.
const inflight = new Map<number, Promise<ShapedProduct[]>>();

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

  /** Catálogo compactado, read-through sobre woocommerce_cache. */
  async getProducts(clientId: number): Promise<{ items: ShapedProduct[]; cached: boolean; fetched_at: string; currency: string | null }> {
    const conn = await this.getConnection(clientId);
    if (!conn) throw new WooError('Este workspace no tiene WooCommerce conectado', 404);

    const { data: row, error } = await supabase
      .from('woocommerce_cache')
      .select('payload, fetched_at, expires_at')
      .eq('client_id', clientId)
      .eq('resource', 'products')
      .maybeSingle();
    if (error) throw error;

    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return {
        items: (row.payload as ShapedProduct[]) ?? [],
        cached: true,
        fetched_at: row.fetched_at as string,
        currency: conn.currency,
      };
    }

    let pending = inflight.get(clientId);
    if (!pending) {
      pending = fetchShapedCatalog(credsOf(conn)).finally(() => inflight.delete(clientId));
      inflight.set(clientId, pending);
    }
    const items = await pending;

    const now = new Date();
    const fetchedAt = now.toISOString();
    const { error: upErr } = await supabase.from('woocommerce_cache').upsert(
      {
        client_id: clientId,
        resource: 'products',
        payload: items,
        fetched_at: fetchedAt,
        expires_at: new Date(now.getTime() + ttlMs()).toISOString(),
        updated_at: fetchedAt,
      },
      { onConflict: 'client_id,resource' },
    );
    if (upErr) throw upErr;

    return { items, cached: false, fetched_at: fetchedAt, currency: conn.currency };
  },

  /** Lo que ve el agente al buscar: filtrado por texto y acotado para no inflar el prompt. */
  async searchProducts(clientId: number, query?: string) {
    const { items, cached, fetched_at, currency } = await this.getProducts(clientId);
    const matches = filterByQuery(items, query);
    return {
      items: matches.slice(0, MAX_SEARCH_RESULTS),
      count: matches.length,
      ...(matches.length > MAX_SEARCH_RESULTS
        ? { note: `Hay ${matches.length} resultados; se muestran los primeros ${MAX_SEARCH_RESULTS}. Buscá algo más específico.` }
        : {}),
      currency,
      cached,
      fetched_at,
    };
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
