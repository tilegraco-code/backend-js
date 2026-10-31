// Shaping de la API de MercadoLibre a la forma compacta que ven las tools del agente.
// Puro (sin red ni DB) para poder testearlo. Nunca devuelve datos personales del
// comprador: no verificamos identidad, alcanza con el número de venta.
import type {
  MercadolibreItem,
  MercadolibreOrder,
  MercadolibrePaymentMethod,
  MercadolibreShipment,
  MercadolibreShippingOptions,
} from '../types/mercadolibre';

const MAX_ATTRIBUTES = 30;
const MAX_DESCRIPTION_CHARS = 1500;

// ── Entradas del comprador ──────────────────────────────────────────────────

/**
 * Id de publicación a partir de lo que mande el agente: "MLA123456789", "MLA-123456789"
 * o el link de la publicación (que lo trae con guion). null si no hay ninguno.
 */
export function itemIdFrom(input: string): string | null {
  const match = input.trim().toUpperCase().match(/\b([A-Z]{3})-?(\d{6,})\b/);
  return match ? `${match[1]}${match[2]}` : null;
}

/** Número de venta: solo dígitos ("#2000012345678" o "2000 0123 4567" sirven). */
export function orderNumberFrom(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

// ── Traducciones ────────────────────────────────────────────────────────────

const CONDITION: Record<string, string> = { new: 'nuevo', used: 'usado', refurbished: 'reacondicionado' };

const LOGISTIC: Record<string, string> = {
  fulfillment: 'Mercado Envíos Full',
  self_service: 'Mercado Envíos Flex',
  cross_docking: 'Mercado Envíos',
  drop_off: 'Mercado Envíos',
  xd_drop_off: 'Mercado Envíos',
  default: 'Mercado Envíos',
  custom: 'envío propio del vendedor',
  not_specified: 'a coordinar con el vendedor',
};

const ORDER_STATUS: Record<string, string> = {
  confirmed: 'Confirmada, esperando el pago',
  payment_required: 'Esperando el pago',
  payment_in_process: 'Pago en proceso',
  partially_paid: 'Pagada parcialmente',
  paid: 'Pagada',
  partially_refunded: 'Reembolsada parcialmente',
  pending_cancel: 'Cancelación en curso',
  cancelled: 'Cancelada',
};

const PAYMENT_STATUS: Record<string, string> = {
  approved: 'aprobado',
  pending: 'pendiente',
  in_process: 'en revisión',
  in_mediation: 'en mediación',
  authorized: 'autorizado',
  rejected: 'rechazado',
  refunded: 'devuelto',
  cancelled: 'cancelado',
  charged_back: 'contracargo',
};

const PAYMENT_TYPE: Record<string, string> = {
  credit_card: 'Tarjeta de crédito',
  debit_card: 'Tarjeta de débito',
  prepaid_card: 'Tarjeta prepaga',
  account_money: 'Dinero en cuenta de Mercado Pago',
  ticket: 'Efectivo (pago en puntos de cobranza)',
  atm: 'Cajero automático',
  bank_transfer: 'Transferencia bancaria',
  digital_currency: 'Mercado Crédito',
  digital_wallet: 'Billetera digital',
};

const SHIPMENT_STATUS: Record<string, string> = {
  pending: 'Pendiente: todavía no se puede despachar',
  handling: 'En preparación',
  ready_to_ship: 'Listo para despachar',
  shipped: 'En camino',
  delivered: 'Entregado',
  not_delivered: 'No entregado',
  cancelled: 'Cancelado',
  to_be_agreed: 'Envío a coordinar con el vendedor',
};

const SHIPMENT_SUBSTATUS: Record<string, string> = {
  ready_to_print: 'el vendedor está preparando el paquete',
  printed: 'el vendedor está preparando el paquete',
  in_packing_list: 'el vendedor está preparando el paquete',
  in_warehouse: 'en el centro de distribución',
  ready_for_pickup: 'esperando que el correo lo retire',
  picked_up: 'el correo ya lo retiró',
  dropped_off: 'despachado en el correo',
  in_hub: 'en el centro de distribución',
  in_transit: 'viajando al destino',
  out_for_delivery: 'salió a reparto',
  soon_deliver: 'llega pronto',
  delayed: 'demorado',
  waiting_for_withdrawal: 'esperando que lo retires en la sucursal',
  receiver_absent: 'no había nadie para recibirlo',
  bad_address: 'problema con la dirección',
  returning_to_sender: 'volviendo al vendedor',
  returned: 'devuelto al vendedor',
  stolen: 'reportado como robado',
  lost: 'reportado como perdido',
  damaged: 'reportado como dañado',
};

function label(map: Record<string, string>, key: string | null | undefined): string | null {
  if (!key) return null;
  return map[key] ?? key;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

/** Precio de lista solo si hay descuento: si no, es ruido. */
function originalIfDiscount(item: { price?: number; original_price?: number | null }) {
  return item.original_price && item.price != null && item.original_price > item.price
    ? { original_price: item.original_price }
    : {};
}

function optionsOf(v: { attribute_combinations?: { name?: string; value_name?: string | null }[] }): string[] {
  return (v.attribute_combinations ?? [])
    .filter((c) => c.value_name)
    .map((c) => (c.name ? `${c.name}: ${c.value_name}` : String(c.value_name)));
}

/** Garantía: el campo viejo `warranty` o los sale_terms WARRANTY_TYPE / WARRANTY_TIME. */
function warrantyOf(item: MercadolibreItem): string | null {
  const terms = (item.sale_terms ?? []).filter(
    (t) => (t.id === 'WARRANTY_TYPE' || t.id === 'WARRANTY_TIME') && t.value_name,
  );
  if (terms.length) return terms.map((t) => t.value_name).join(', ');
  return item.warranty?.trim() || null;
}

function shippingOf(item: MercadolibreItem) {
  const s = item.shipping ?? {};
  return {
    free_shipping: Boolean(s.free_shipping),
    local_pick_up: Boolean(s.local_pick_up),
    type: label(LOGISTIC, s.logistic_type ?? (s.mode === 'not_specified' ? 'not_specified' : null)),
  };
}

// ── Productos ───────────────────────────────────────────────────────────────

export function isSellable(item: MercadolibreItem, sellerId: number): boolean {
  return item.status === 'active' && Number(item.seller_id) === Number(sellerId);
}

/** Lo justo para listar resultados de búsqueda. */
export function shapeSearchItem(item: MercadolibreItem) {
  const variants = item.variations?.length ?? 0;
  return {
    item_id: item.id,
    title: item.title ?? null,
    price: item.price ?? null,
    ...originalIfDiscount(item),
    currency: item.currency_id ?? null,
    stock: item.available_quantity ?? null,
    condition: label(CONDITION, item.condition),
    free_shipping: Boolean(item.shipping?.free_shipping),
    ...(variants ? { variants } : {}),
    url: item.permalink ?? null,
  };
}

/** Ficha completa: atributos, garantía, envío, variantes y descripción. */
export function shapeItemDetail(item: MercadolibreItem, description: string | null) {
  const attributes = (item.attributes ?? [])
    .filter((a) => a.name && a.value_name)
    .slice(0, MAX_ATTRIBUTES)
    .map((a) => `${a.name}: ${a.value_name}`);
  const variants = (item.variations ?? [])
    .map((v) => ({
      variation_id: v.id ?? null,
      options: optionsOf(v),
      ...(v.price != null && v.price !== item.price ? { price: v.price } : {}),
    }))
    .filter((v) => v.options.length);
  const warranty = warrantyOf(item);
  return {
    item_id: item.id,
    title: item.title ?? null,
    price: item.price ?? null,
    ...originalIfDiscount(item),
    currency: item.currency_id ?? null,
    condition: label(CONDITION, item.condition),
    stock: item.available_quantity ?? null,
    ...(warranty ? { warranty } : {}),
    shipping: shippingOf(item),
    ...(attributes.length ? { attributes } : {}),
    ...(variants.length ? { variants } : {}),
    ...(description ? { description: clip(description, MAX_DESCRIPTION_CHARS) } : {}),
    url: item.permalink ?? null,
  };
}

/** Stock total y por variante (talle, color...). */
export function shapeStock(item: MercadolibreItem) {
  const variants = (item.variations ?? []).map((v) => ({
    variation_id: v.id ?? null,
    options: optionsOf(v),
    stock: v.available_quantity ?? 0,
    ...(v.price != null && v.price !== item.price ? { price: v.price } : {}),
  }));
  const total = variants.length
    ? variants.reduce((sum, v) => sum + v.stock, 0)
    : (item.available_quantity ?? 0);
  return {
    item_id: item.id,
    title: item.title ?? null,
    available: total > 0,
    stock: total,
    ...(variants.length ? { variants } : {}),
    url: item.permalink ?? null,
  };
}

// ── Envío a un código postal ────────────────────────────────────────────────

export function shapeShippingOptions(
  item: MercadolibreItem,
  zipCode: string,
  raw: MercadolibreShippingOptions,
) {
  const options = (raw.options ?? []).map((o) => {
    const eta = o.estimated_delivery_time;
    return {
      name: o.name ?? o.display ?? 'Envío',
      cost: o.cost ?? null,
      ...(o.list_cost != null && o.cost != null && o.list_cost > o.cost ? { list_cost: o.list_cost } : {}),
      free: o.cost === 0,
      currency: o.currency_id ?? item.currency_id ?? null,
      ...(eta?.date ? { estimated_delivery: eta.date.slice(0, 10) } : {}),
    };
  });
  const city = raw.destination?.city?.name;
  const state = raw.destination?.state?.name;
  return {
    item_id: item.id,
    title: item.title ?? null,
    zip_code: zipCode,
    ...(city || state ? { destination: [city, state].filter(Boolean).join(', ') } : {}),
    ships: options.length > 0,
    options,
    local_pick_up: Boolean(item.shipping?.local_pick_up),
  };
}

// ── Ventas ──────────────────────────────────────────────────────────────────

function day(date: string | null | undefined): string | null {
  return date ? date.slice(0, 10) : null;
}

/**
 * Estado de una venta. `orders` son las órdenes de la misma compra: una sola si el
 * comprador compró una publicación, varias si fue un carrito (pack).
 */
export function shapeOrders(orders: MercadolibreOrder[], packId: number | null) {
  const first = orders[0];
  const items = orders.flatMap((o) =>
    (o.order_items ?? []).map((it) => ({
      title: it.item?.title ?? null,
      quantity: it.quantity ?? 1,
      unit_price: it.unit_price ?? null,
    })),
  );
  const payments = orders.flatMap((o) => o.payments ?? []);
  const paid = payments.find((p) => p.status === 'approved') ?? payments[0];
  const total = orders.reduce((sum, o) => sum + (o.total_amount ?? 0), 0);
  return {
    found: true,
    order_number: String(packId ?? first?.id ?? ''),
    status: label(ORDER_STATUS, first?.status),
    created: day(first?.date_created),
    items,
    total,
    currency: first?.currency_id ?? null,
    ...(paid
      ? {
          payment: {
            status: label(PAYMENT_STATUS, paid.status),
            method: label(PAYMENT_TYPE, paid.payment_type),
            ...(paid.installments && paid.installments > 1 ? { installments: paid.installments } : {}),
            ...(paid.date_approved ? { approved: day(paid.date_approved) } : {}),
          },
        }
      : {}),
    has_shipping: orders.some((o) => o.shipping?.id),
  };
}

export function shapeShipment(shipment: MercadolibreShipment, orderNumber: string) {
  const history = shipment.status_history ?? {};
  const city = shipment.destination?.shipping_address?.city?.name;
  const state = shipment.destination?.shipping_address?.state?.name;
  const logistic = shipment.logistic?.type ?? shipment.logistic_type;
  const eta = shipment.lead_time?.estimated_delivery_time?.date;
  return {
    found: true,
    order_number: orderNumber,
    status: label(SHIPMENT_STATUS, shipment.status),
    ...(shipment.substatus ? { detail: label(SHIPMENT_SUBSTATUS, shipment.substatus) } : {}),
    ...(logistic ? { shipping_type: label(LOGISTIC, logistic) } : {}),
    ...(shipment.tracking_method ? { carrier: shipment.tracking_method } : {}),
    ...(shipment.tracking_number ? { tracking_number: shipment.tracking_number } : {}),
    ...(eta && shipment.status !== 'delivered' ? { estimated_delivery: day(eta) } : {}),
    dates: {
      ...(history.date_handling ? { preparing: day(history.date_handling) } : {}),
      ...(history.date_shipped ? { shipped: day(history.date_shipped) } : {}),
      ...(history.date_delivered ? { delivered: day(history.date_delivered) } : {}),
      ...(history.date_not_delivered ? { not_delivered: day(history.date_not_delivered) } : {}),
      ...(history.date_cancelled ? { cancelled: day(history.date_cancelled) } : {}),
    },
    ...(city || state ? { destination: [city, state].filter(Boolean).join(', ') } : {}),
  };
}

/**
 * Facturas de la venta. ML documenta la respuesta como lista y como objeto con
 * `fiscal_documents`, así que se aceptan las dos. No se devuelve el archivo: bajarlo
 * pide el token del vendedor, y el comprador ya la tiene en "Mis compras".
 */
export function shapeFiscalDocuments(raw: unknown, orderNumber: string) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { fiscal_documents?: unknown })?.fiscal_documents)
    ? (raw as { fiscal_documents: unknown[] }).fiscal_documents
    : [];
  const docs = (list as { date?: string; date_created?: string; file_type?: string; type?: string }[]).map(
    (d) => ({
      date: day(d.date ?? d.date_created),
      ...(d.type || d.file_type ? { type: d.type ?? d.file_type } : {}),
    }),
  );
  return {
    found: true,
    order_number: orderNumber,
    has_invoice: docs.length > 0,
    invoices: docs,
  };
}

// ── Medios de pago ──────────────────────────────────────────────────────────

/** Agrupados por tipo: "Tarjeta de crédito: Visa, Mastercard, ...". */
export function shapePaymentMethods(methods: MercadolibrePaymentMethod[]) {
  const groups = new Map<string, string[]>();
  for (const m of methods) {
    if (m.status && m.status !== 'active') continue;
    const type = label(PAYMENT_TYPE, m.payment_type_id) ?? 'Otros';
    const names = groups.get(type) ?? [];
    if (m.name && !names.includes(m.name)) names.push(m.name);
    groups.set(type, names);
  }
  return {
    payment_methods: [...groups].map(([type, names]) => ({ type, methods: names })),
    note: 'Son los medios que acepta MercadoLibre para cualquier compra; las cuotas disponibles se ven al pagar.',
  };
}
