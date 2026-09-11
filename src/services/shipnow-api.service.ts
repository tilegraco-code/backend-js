// Cliente HTTP de bajo nivel para shipnow (https://shipnow.stoplight.io/docs/shipnow-api).
//
// Auth: token fijo por cuenta en `Authorization: Bearer <token>`. No hay OAuth ni
// refresh — el token se pide por mail a developers@shipnow.com.ar. Por eso este
// servicio no tiene nada de token lifecycle: recibe el token ya resuelto y pega.
//
// El ambiente de pruebas de shipnow NO es otra URL: es otro token (una cuenta de
// test). Igual dejamos SHIPNOW_API_BASE configurable por si mueven el host.

const DEFAULT_API_BASE = 'https://api.shipnow.com.ar';

function apiBase(): string {
  return (process.env.SHIPNOW_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, '');
}

/** Envío del pedido: es lo que tiene el estado fino una vez despachado al correo. */
export type ShipnowShipment = {
  id?: number;
  status?: string | null;
  tracking_number?: string | null;
  external_tracking_url?: string | null;
  created_at?: string | null;
  shipped_at?: string | null;
  in_post_office_at?: string | null;
  out_for_delivery_at?: string | null;
  delivered_at?: string | null;
  not_delivered_at?: string | null;
  last_update_carrier_at?: string | null;
  carrier?: {
    code?: string | null;
    name?: string | null;
    description?: string | null;
    tracking_url?: string | null;
  } | null;
  [key: string]: unknown;
};

/** Subset de Order (el modelo completo trae items, direcciones y precios). */
export type ShipnowOrder = {
  id: number;
  status?: string | null;
  last_status?: string | null;
  // OJO: en shipnow external_reference es NUMÉRICO (es el nro de orden de la tienda).
  external_reference?: number | null;
  external_reference_user?: string | null;
  uid?: string | null;
  tracking_url?: string | null;
  estimated_delivery?: string | null;
  minimum_delivery?: string | null;
  maximum_delivery?: string | null;
  type?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  timestamps?: Record<string, string | null> | null;
  shipping_option?: { carrier_code?: string | null; service_type?: string | null } | null;
  store?: { id?: number; name?: string | null; store_type?: string | null } | null;
  ship_to?: Record<string, unknown> | null;
  shipment?: ShipnowShipment | null;
  [key: string]: unknown;
};

type ShipnowListResponse = { results?: ShipnowOrder[] };

async function request<T>(token: string, path: string): Promise<T | null> {
  const res = await fetch(`${apiBase()}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // 404 = no existe ese pedido. No es un error del sistema: lo distinguimos del
  // resto para que el caller pueda decir "no encontré esa orden" sin romper.
  if (res.status === 404) return null;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`shipnow ${path} ${res.status}: ${errText.slice(0, 300)}`);
  }

  return (await res.json()) as T;
}

export const shipnowApiService = {
  /**
   * Busca pedidos por la referencia externa: el número de orden de la tienda
   * (TiendaNube / Shopify / ERP). Es único por cuenta, así que devuelve 0 o 1.
   */
  async findOrdersByExternalReference(token: string, externalReference: string): Promise<ShipnowOrder[]> {
    const qs = new URLSearchParams({ external_reference: externalReference, per_page: '5' });
    const data = await request<ShipnowListResponse>(token, `/orders?${qs.toString()}`);
    return data?.results ?? [];
  },

  /** Trae un pedido por su ID interno de shipnow. null si no existe. */
  async getOrder(token: string, id: number): Promise<ShipnowOrder | null> {
    return request<ShipnowOrder>(token, `/orders/${id}`);
  },

  /**
   * Valida un token pidiendo la primera página de pedidos. Devuelve el nombre del
   * punto de venta si lo puede inferir (sólo para mostrarlo en el dashboard).
   * Lanza si el token es inválido (shipnow responde 401).
   */
  async validateToken(token: string): Promise<{ accountName: string | null }> {
    const data = await request<ShipnowListResponse>(token, '/orders?per_page=1');
    const first = data?.results?.[0];
    return { accountName: first?.store?.name ?? null };
  },
};
