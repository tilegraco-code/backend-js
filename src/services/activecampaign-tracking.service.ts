// Seguimiento del envío de un pedido leído de ActiveCampaign (vía Composio), para tiendas
// que lo guardan ahí en vez de en la tienda. Se usa desde "Estado del pedido" de
// WooCommerce: con el email de facturación se busca el contacto, se elige el deal del
// pedido por fecha y se leen sus campos de envío.
//
// No hay tool de Composio para los campos personalizados de un deal, por eso va por
// composioService.proxy (API de ActiveCampaign con la cuenta conectada del cliente).
// Todo es best-effort: sin ActiveCampaign conectado, sin contacto o ante cualquier error
// devuelve "sin seguimiento" y la consulta del pedido sigue igual.
import { composioService } from './composio.service';
import {
  AcDeal,
  AcFieldMeta,
  AcFieldValue,
  AcTracking,
  mapDealTracking,
  pickDealForOrder,
} from './activecampaign-tracking.shape';

const TOOLKIT = 'active_campaign';
const TIMEOUT_MS = 10_000;
const META_TTL_MS = 60 * 60_000;

// Definiciones de campos de deal por cliente: cambian casi nunca.
const metaCache = new Map<number, { metas: AcFieldMeta[]; ts: number }>();

async function get<T>(clientId: number, endpoint: string, query?: Record<string, string | number>): Promise<T | null> {
  const res = await composioService.proxy(clientId, TOOLKIT, endpoint, query);
  if (!res.connected || res.status >= 400) return null;
  return (res.data as T) ?? null;
}

async function dealFieldMetas(clientId: number): Promise<AcFieldMeta[]> {
  const hit = metaCache.get(clientId);
  if (hit && Date.now() - hit.ts < META_TTL_MS) return hit.metas;
  const data = await get<{ dealCustomFieldMeta?: AcFieldMeta[] }>(clientId, '/api/3/dealCustomFieldMeta', { limit: 100 });
  const metas = data?.dealCustomFieldMeta ?? [];
  // Sólo se cachea una respuesta real: sin app conectada o con error se reintenta la próxima.
  if (data) metaCache.set(clientId, { metas, ts: Date.now() });
  return metas;
}

function withTimeout<T>(p: Promise<T>, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), TIMEOUT_MS))]);
}

async function lookup(
  clientId: number,
  email: string,
  orders: { id: number; date: string | null }[],
): Promise<Map<number, AcTracking>> {
  const out = new Map<number, AcTracking>();
  const contacts = await get<{ contacts?: { id: string }[] }>(clientId, '/api/3/contacts', { email });
  const contactId = contacts?.contacts?.[0]?.id;
  if (!contactId) return out;

  const [dealsRes, metas] = await Promise.all([
    get<{ deals?: AcDeal[] }>(clientId, `/api/3/contacts/${contactId}/deals`, { limit: 100 }),
    dealFieldMetas(clientId),
  ]);
  const deals = dealsRes?.deals ?? [];
  if (deals.length === 0 || metas.length === 0) return out;

  await Promise.all(
    orders.map(async (o) => {
      const deal = pickDealForOrder(deals, o.date);
      if (!deal) return;
      const fields = await get<{ dealCustomFieldData?: AcFieldValue[] }>(
        clientId,
        `/api/3/deals/${deal.id}/dealCustomFieldData`,
      );
      const tracking = mapDealTracking(fields?.dealCustomFieldData ?? [], metas);
      if (tracking) out.set(o.id, tracking);
    }),
  );
  return out;
}

export const activeCampaignTracking = {
  /**
   * Seguimiento por pedido (orderId → tracking) para pedidos de un mismo email. Una sola
   * búsqueda de contacto y deals para todos; un request por pedido para sus campos.
   */
  async forOrders(
    clientId: number,
    email: string | null | undefined,
    orders: { id: number; date: string | null }[],
  ): Promise<Map<number, AcTracking>> {
    if (!email?.trim() || orders.length === 0) return new Map();
    return withTimeout(
      lookup(clientId, email.trim().toLowerCase(), orders).catch(() => new Map<number, AcTracking>()),
      new Map(),
    );
  },
};
