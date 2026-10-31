// Tools de solo lectura de MercadoLibre para el agente: productos, stock, envíos,
// estado de la venta, factura y medios de pago. Las usa cualquier agente del
// cliente, tenga o no activo el canal de ML: alcanza con la cuenta conectada.
// Ver docs/mercadolibre-tools.md.
import { supabase } from '../lib/supabase';
import { filterByQuery } from '../lib/text-search';
import { MercadolibreApiError, mercadolibreApiService } from './mercadolibre-api.service';
import { mercadolibreService } from './mercadolibre.service';
import {
  isSellable,
  itemIdFrom,
  orderNumberFrom,
  shapeFiscalDocuments,
  shapeItemDetail,
  shapeOrders,
  shapePaymentMethods,
  shapeSearchItem,
  shapeShipment,
  shapeShippingOptions,
  shapeStock,
} from './mercadolibre-tools.shape';
import type { MercadolibreItem, MercadolibreOrder, MercadolibrePaymentMethod } from '../types/mercadolibre';

const MAX_SEARCH_RESULTS = 10;
/** Tope de publicaciones que se recorren cuando el filtro `q` de ML no encuentra nada. */
const FALLBACK_SCAN = 200;
const MAX_PACK_ORDERS = 10;
const PAYMENT_METHODS_TTL_MS = 24 * 60 * 60_000;

/** Error con un mensaje pensado para el agente (se le devuelve tal cual). */
export class MlToolError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'MlToolError';
  }
}

type Account = { mlUserId: number; siteId: string; nickname: string | null };

/** Medios de pago por país: no dependen del vendedor y cambian muy poco. */
const paymentMethodsCache = new Map<string, { at: number; methods: MercadolibrePaymentMethod[] }>();

/**
 * Traduce los errores de ML a algo que el agente pueda explicar. `what` es lo que se
 * estaba consultando ("la publicación", "la venta"...), para el 404.
 */
function toToolError(err: unknown, what: string): MlToolError {
  if (err instanceof MlToolError) return err;
  if (err instanceof MercadolibreApiError) {
    if (err.status === 404) return new MlToolError(`No encontré ${what}.`, 404);
    if (err.status === 401) {
      return new MlToolError(
        'La cuenta de MercadoLibre perdió la autorización. Hay que reconectarla desde Canales.',
        502,
      );
    }
    if (err.status === 403) {
      return new MlToolError(
        `MercadoLibre no nos deja consultar ${what} con esta cuenta (falta un permiso de la aplicación). Hay que reconectar la cuenta.`,
        403,
      );
    }
    return new MlToolError('MercadoLibre no respondió. Probá de nuevo en un rato.', 502);
  }
  return new MlToolError('No se pudo consultar MercadoLibre.', 500);
}

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

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export const mercadolibreToolsService = {
  /**
   * Cuenta que usa la tool. Con `mlUserId` (la que eligió el cliente) solo si es suya,
   * sin caer a otra: contestarle con el catálogo de otra cuenta es peor que avisar.
   * Sin él, la principal (la conectada primero).
   *
   * Se identifica por ml_user_id y no por el id de la fila porque el corte por impago
   * borra la conexión: al reconectar, la fila es otra pero la cuenta es la misma.
   */
  async resolveAccount(clientId: number, mlUserId?: number | null): Promise<Account> {
    const base = supabase
      .from('mercadolibre_connections')
      .select('ml_user_id, site_id, nickname')
      .eq('client_id', clientId);
    const { data, error } = await (mlUserId
      ? base.eq('ml_user_id', mlUserId)
      : base.order('id', { ascending: true }).limit(1)
    ).maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new MlToolError(
        mlUserId
          ? 'La cuenta de MercadoLibre asignada a esta herramienta ya no está conectada. Hay que reconectarla o elegir otra en la herramienta del agente.'
          : 'Este workspace no tiene MercadoLibre conectado',
        404,
      );
    }
    return { mlUserId: Number(data.ml_user_id), siteId: data.site_id, nickname: data.nickname };
  },

  async token(account: Account): Promise<string> {
    try {
      return await mercadolibreService.getValidToken(account.mlUserId);
    } catch (err) {
      throw toToolError(err, 'la cuenta');
    }
  },

  /** Publicaciones activas del vendedor, por id. Las de otros vendedores no existen. */
  async fetchSellable(ids: string[], account: Account, token: string): Promise<MercadolibreItem[]> {
    const batches = await mapLimit(chunk(ids, 20), 3, (b) => mercadolibreApiService.fetchItems(b, token));
    return batches
      .flat()
      .filter((e) => e.code === 200 && e.body && isSellable(e.body, account.mlUserId))
      .map((e) => e.body);
  },

  /** Una publicación activa del vendedor, o error claro para el agente. */
  async requireItem(account: Account, token: string, rawId: string): Promise<MercadolibreItem> {
    const itemId = itemIdFrom(rawId);
    if (!itemId) {
      throw new MlToolError(
        'Necesito el item_id de la publicación (ej. MLA123456789). Buscalo primero con la búsqueda de productos.',
        400,
      );
    }
    let item: MercadolibreItem;
    try {
      item = await mercadolibreApiService.fetchItem(itemId, token);
    } catch (err) {
      throw toToolError(err, `la publicación ${itemId}`);
    }
    if (!isSellable(item, account.mlUserId)) {
      throw new MlToolError(`La publicación ${itemId} no es de esta cuenta o no está activa.`, 404);
    }
    return item;
  },

  /**
   * Busca entre las publicaciones activas. Primero con el filtro `q` de ML; si no trae
   * nada, recorre las primeras publicaciones y filtra local (tolerante a acentos y
   * plurales), por si el título no matchea literal.
   */
  async searchProducts(clientId: number, query: string | undefined, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const q = query?.trim() || undefined;

    try {
      const res = await mercadolibreApiService.searchSellerItems(account.mlUserId, token, {
        query: q,
        limit: MAX_SEARCH_RESULTS,
      });
      let items = await this.fetchSellable(res.results ?? [], account, token);
      let total = res.paging?.total ?? items.length;

      if (q && items.length === 0) {
        const ids: string[] = [];
        for (let offset = 0; offset < FALLBACK_SCAN; offset += 100) {
          const page = await mercadolibreApiService.searchSellerItems(account.mlUserId, token, {
            limit: 100,
            offset,
          });
          ids.push(...(page.results ?? []));
          if ((page.results?.length ?? 0) < 100) break;
        }
        const all = await this.fetchSellable(ids, account, token);
        // Se filtra por el título: el item crudo tiene demasiado ruido (ids, tags, URLs).
        const matches = all.filter((it) => filterByQuery([{ title: it.title ?? '' }], q).length > 0);
        items = matches.slice(0, MAX_SEARCH_RESULTS);
        total = matches.length;
      }

      return {
        items: items.map(shapeSearchItem),
        count: total,
        ...(total > items.length
          ? { note: `Hay ${total} publicaciones; se muestran ${items.length}. Buscá algo más específico.` }
          : {}),
      };
    } catch (err) {
      throw toToolError(err, 'las publicaciones');
    }
  },

  async getProductDetail(clientId: number, rawItemId: string, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const item = await this.requireItem(account, token, rawItemId);
    // Muchas publicaciones no tienen descripción: un 404 acá no es un error.
    const description = await mercadolibreApiService.fetchItemDescription(item.id, token).catch(() => null);
    return shapeItemDetail(item, description);
  },

  async getStock(clientId: number, rawItemId: string, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    return shapeStock(await this.requireItem(account, token, rawItemId));
  },

  async getShippingCost(clientId: number, rawItemId: string, zipCode: string, mlUserId?: number | null) {
    const zip = zipCode.replace(/\s/g, '');
    if (!/^[A-Za-z0-9-]{4,10}$/.test(zip)) {
      throw new MlToolError('Necesito un código postal válido (ej. 1414).', 400);
    }
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const item = await this.requireItem(account, token, rawItemId);
    try {
      const raw = await mercadolibreApiService.fetchShippingOptions(item.id, zip, token);
      return shapeShippingOptions(item, zip, raw);
    } catch (err) {
      if (err instanceof MercadolibreApiError && err.status === 400) {
        throw new MlToolError(`MercadoLibre no reconoce el código postal ${zip}. Pedile al comprador que lo revise.`, 400);
      }
      throw toToolError(err, 'el envío de esa publicación');
    }
  },

  /**
   * Órdenes de una venta a partir del número que da el comprador. Puede ser el de la
   * orden o el del pack (carrito): ML le muestra uno u otro según cómo compró, así que
   * se prueban los dos. Con un pack se devuelven todas sus órdenes.
   */
  async findSale(
    account: Account,
    token: string,
    rawNumber: string,
  ): Promise<{ orders: MercadolibreOrder[]; packId: number | null; number: string }> {
    const number = orderNumberFrom(rawNumber);
    if (!number) {
      throw new MlToolError('Necesito el número de venta (lo ve el comprador en el detalle de su compra).', 400);
    }
    const mine = (o: MercadolibreOrder) => Number(o.seller?.id) === account.mlUserId;
    const notFound = new MlToolError(
      `No encontré una venta con el número ${number}. Pedile al comprador que lo revise.`,
      404,
    );
    const missing = (err: unknown) =>
      err instanceof MercadolibreApiError && [400, 403, 404].includes(err.status);

    let order: MercadolibreOrder | null = null;
    try {
      order = await mercadolibreApiService.fetchOrder(number, token);
    } catch (err) {
      if (!missing(err)) throw toToolError(err, 'la venta');
    }

    const packId = order ? (order.pack_id ?? null) : Number(number);
    if (order && !packId) {
      if (!mine(order)) throw notFound;
      return { orders: [order], packId: null, number };
    }

    let orderIds: number[];
    try {
      const pack = await mercadolibreApiService.fetchPack(packId!, token);
      orderIds = (pack.orders ?? []).map((o) => o.id).slice(0, MAX_PACK_ORDERS);
    } catch (err) {
      if (!missing(err)) throw toToolError(err, 'la venta');
      // Orden con pack_id pero el pack no se pudo leer: alcanza con la orden.
      if (order && mine(order)) return { orders: [order], packId: null, number };
      throw notFound;
    }

    const orders = (
      await mapLimit(orderIds, 3, (id) =>
        id === order?.id ? Promise.resolve(order) : mercadolibreApiService.fetchOrder(id, token).catch(() => null),
      )
    ).filter((o): o is MercadolibreOrder => Boolean(o) && mine(o!));
    if (orders.length === 0) throw notFound;
    return { orders, packId, number };
  },

  async getOrderStatus(clientId: number, rawNumber: string, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const { orders, packId } = await this.findSale(account, token, rawNumber);
    return shapeOrders(orders, packId);
  },

  async getShipmentStatus(clientId: number, rawNumber: string, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const { orders, packId, number } = await this.findSale(account, token, rawNumber);
    const shipmentId = orders.find((o) => o.shipping?.id)?.shipping?.id;
    const orderNumber = String(packId ?? orders[0].id ?? number);
    if (!shipmentId) {
      return {
        found: true,
        order_number: orderNumber,
        status: 'Sin envío por MercadoLibre: la entrega se coordina con el vendedor.',
      };
    }
    try {
      return shapeShipment(await mercadolibreApiService.fetchShipment(shipmentId, token), orderNumber);
    } catch (err) {
      throw toToolError(err, 'el envío de esa venta');
    }
  },

  async getInvoice(clientId: number, rawNumber: string, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const token = await this.token(account);
    const { orders, packId } = await this.findSale(account, token, rawNumber);
    const ref = packId ?? orders[0].id;
    try {
      return shapeFiscalDocuments(await mercadolibreApiService.fetchFiscalDocuments(ref, token), String(ref));
    } catch (err) {
      // Sin factura cargada ML responde 404: es un dato, no un error.
      if (err instanceof MercadolibreApiError && err.status === 404) {
        return shapeFiscalDocuments([], String(ref));
      }
      throw toToolError(err, 'la factura de esa venta');
    }
  },

  async getPaymentMethods(clientId: number, mlUserId?: number | null) {
    const account = await this.resolveAccount(clientId, mlUserId);
    const hit = paymentMethodsCache.get(account.siteId);
    if (hit && Date.now() - hit.at < PAYMENT_METHODS_TTL_MS) return shapePaymentMethods(hit.methods);

    const token = await this.token(account);
    try {
      const methods = await mercadolibreApiService.fetchPaymentMethods(account.siteId, token);
      paymentMethodsCache.set(account.siteId, { at: Date.now(), methods });
      return shapePaymentMethods(methods);
    } catch (err) {
      throw toToolError(err, 'los medios de pago');
    }
  },
};
