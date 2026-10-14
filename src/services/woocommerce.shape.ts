// Shaping del catálogo de WooCommerce a la forma compacta que ve el agente. Puro
// (sin red ni DB) para poder testearlo.
import { normalizeText } from '../lib/text-search';
import type {
  WooCountry,
  WooOrder,
  WooOrderNote,
  WooProduct,
  WooProductDetail,
  WooReview,
  WooVariation,
  WooZoneLocation,
  WooZoneMethod,
} from './woocommerce-api.service';

// Forma compacta (sin HTML ni imágenes) con lo que el agente necesita para
// recomendar y armar el pedido. Los ids son los que pide create_checkout.

export type ShapedVariant = {
  variation_id: number;
  options: string[];
  price: string | null;
  regular_price?: string;
  stock: number | string;
};

export type ShapedProduct = {
  product_id: number;
  name: string | null;
  url: string | null;
  categories?: string[];
  description?: string;
  purchasable: boolean;
  price?: string | null;
  regular_price?: string;
  stock?: number | string;
  variants?: ShapedVariant[];
};

function stripHtml(html: string | undefined, max = 200): string | undefined {
  if (!html) return undefined;
  const text = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function stockOf(p: {
  manage_stock?: boolean | 'parent';
  stock_quantity?: number | null;
  stock_status?: string;
}): number | string {
  if (p.manage_stock === true && typeof p.stock_quantity === 'number') return p.stock_quantity;
  if (p.stock_status === 'outofstock') return 0;
  if (p.stock_status === 'onbackorder') return 'por encargo';
  return 'disponible';
}

/** Precio de lista sólo si hay oferta (si no, es ruido). */
function regularIfOnSale(p: { price?: string; regular_price?: string }): { regular_price?: string } {
  return p.regular_price && p.price && p.regular_price !== p.price ? { regular_price: p.regular_price } : {};
}

export function shapeProduct(p: WooProduct, variations: WooVariation[]): ShapedProduct {
  const categories = (p.categories ?? []).map((c) => c.name).filter((n): n is string => Boolean(n));
  const base: ShapedProduct = {
    product_id: p.id,
    name: p.name ?? null,
    url: p.permalink ?? null,
    ...(categories.length ? { categories } : {}),
    ...(stripHtml(p.short_description) ? { description: stripHtml(p.short_description) } : {}),
    // grouped / external no se pueden agregar a un pedido.
    purchasable: Boolean(p.purchasable) && (p.type === 'simple' || p.type === 'variable'),
  };

  if (p.type !== 'variable') {
    return {
      ...base,
      price: p.price || null,
      ...regularIfOnSale(p),
      stock: stockOf(p),
    };
  }

  const variants = variations
    .filter((v) => v.purchasable !== false && (v.status ?? 'publish') === 'publish')
    .map((v) => ({
      variation_id: v.id,
      options: (v.attributes ?? [])
        .filter((a) => a.option)
        .map((a) => (a.name ? `${a.name}: ${a.option}` : String(a.option))),
      price: v.price || null,
      ...regularIfOnSale(v),
      // manage_stock = 'parent' → el stock lo lleva el producto padre.
      stock: v.manage_stock === 'parent' ? stockOf(p) : stockOf(v),
    }));
  return { ...base, variants };
}

// ── Detalle de producto ─────────────────────────────────────────────────────

export function shapeProductDetail(p: WooProductDetail, variations: WooVariation[]): Record<string, unknown> {
  const dims = p.dimensions ?? {};
  const medidas = [dims.length, dims.width, dims.height].every((d) => d)
    ? `${dims.length} x ${dims.width} x ${dims.height}`
    : undefined;
  const attributes = (p.attributes ?? [])
    .filter((a) => a.name && a.options?.length)
    .map((a) => `${a.name}: ${a.options!.join(', ')}`);
  const rating = Number(p.average_rating);
  return {
    ...shapeProduct(p, variations),
    ...(stripHtml(p.description, 1000) ? { description: stripHtml(p.description, 1000) } : {}),
    ...(p.sku ? { sku: p.sku } : {}),
    ...(attributes.length ? { attributes } : {}),
    ...(p.weight ? { weight: p.weight } : {}),
    ...(medidas ? { dimensions: medidas } : {}),
    ...(p.rating_count ? { rating: { average: rating, count: p.rating_count } } : {}),
  };
}

// ── Reseñas ─────────────────────────────────────────────────────────────────

/** Sólo el nombre de pila del autor: el apellido no le aporta nada al comprador. */
export function shapeReview(r: WooReview): Record<string, unknown> {
  return {
    rating: r.rating ?? null,
    review: stripHtml(r.review, 400) ?? '',
    author: r.reviewer?.trim().split(/\s+/)[0] ?? null,
    verified_buyer: Boolean(r.verified),
    date: r.date_created?.slice(0, 10) ?? null,
  };
}

// ── Envíos ──────────────────────────────────────────────────────────────────

export type ZoneWithRules = {
  id: number;
  name: string;
  order: number;
  locations: WooZoneLocation[];
  methods: WooZoneMethod[];
};

export type ShippingDestination = { country: string; state?: string | null; postcode?: string | null };

const CONTINENT_OF: Record<string, string> = {
  AR: 'SA', BO: 'SA', BR: 'SA', CL: 'SA', CO: 'SA', EC: 'SA', PE: 'SA', PY: 'SA', UY: 'SA', VE: 'SA',
  MX: 'NA', US: 'NA', CA: 'NA', ES: 'EU',
};

function cleanPostcode(pc: string): string {
  return pc.toUpperCase().replace(/[\s-]/g, '');
}

/** Mismas reglas que WooCommerce: exacto, comodín final (`1*`) o rango numérico (`1000...1999`). */
export function postcodeMatches(rule: string, postcode: string): boolean {
  const pc = cleanPostcode(postcode);
  const r = cleanPostcode(rule);
  if (r.includes('...')) {
    const [from, to] = r.split('...');
    const n = Number(pc.replace(/\D/g, ''));
    return Number.isFinite(n) && n >= Number(from) && n <= Number(to);
  }
  if (r.endsWith('*')) return pc.startsWith(r.slice(0, -1));
  return pc === r;
}

/**
 * Elige la zona de envío para un destino, como WooCommerce: la primera (por `order`)
 * cuyas regiones (país / provincia / continente) incluyan el destino y, si la zona
 * tiene códigos postales, que el CP coincida. Si no hay ninguna, la zona 0 ("resto").
 *
 * Devuelve 'needs_postcode' / 'needs_state' cuando la respuesta depende de un dato que
 * no nos pasaron (el CP o la provincia): sin él no se puede saber qué zona aplica.
 */
export function matchShippingZone(
  zones: ZoneWithRules[],
  dest: ShippingDestination,
): ZoneWithRules | 'needs_postcode' | 'needs_state' | null {
  const country = dest.country.toUpperCase();
  const state = dest.state ? `${country}:${dest.state.toUpperCase()}` : null;
  const ordered = zones.filter((z) => z.id !== 0 && z.locations.length > 0).sort((a, b) => a.order - b.order);

  for (const zone of ordered) {
    const regions = zone.locations.filter((l) => l.type !== 'postcode');
    const postcodes = zone.locations.filter((l) => l.type === 'postcode');
    const regionOk =
      regions.length === 0 ||
      regions.some(
        (l) =>
          (l.type === 'country' && l.code.toUpperCase() === country) ||
          (l.type === 'state' && state !== null && l.code.toUpperCase() === state) ||
          (l.type === 'continent' && CONTINENT_OF[country] === l.code.toUpperCase()),
      );
    // Zona por provincia de este país y no nos dijeron la provincia: no se puede saber
    // si aplica ésta u otra (la de "todo el país" suele estar más abajo).
    if (!state && regions.some((l) => l.type === 'state' && l.code.toUpperCase().startsWith(`${country}:`))) {
      return 'needs_state';
    }
    if (!regionOk) continue;
    if (postcodes.length === 0) return zone;
    if (!dest.postcode) return 'needs_postcode';
    if (postcodes.some((l) => postcodeMatches(l.code, dest.postcode!))) return zone;
  }
  return zones.find((z) => z.id === 0) ?? null;
}

function settingValue(m: WooZoneMethod, key: string): string | null {
  const v = m.settings?.[key]?.value;
  return v === undefined || v === null || v === '' ? null : String(v);
}

/** Método de envío en la forma que ve el agente. El costo es el configurado en la zona. */
export function shapeShippingMethod(m: WooZoneMethod): Record<string, unknown> {
  const title = m.title || settingValue(m, 'title') || m.method_title || m.method_id || 'Envío';
  if (m.method_id === 'free_shipping') {
    const requires = settingValue(m, 'requires');
    const min = settingValue(m, 'min_amount');
    const condition =
      requires === 'min_amount' || requires === 'either' || requires === 'both'
        ? min
          ? `compra mínima de ${min}${requires === 'either' ? ' (o con cupón de envío gratis)' : requires === 'both' ? ' y cupón de envío gratis' : ''}`
          : null
        : requires === 'coupon'
        ? 'sólo con cupón de envío gratis'
        : null;
    return { method: title, type: 'envío gratis', cost: '0', ...(condition ? { condition } : {}) };
  }
  if (m.method_id === 'local_pickup') {
    return { method: title, type: 'retiro en el local', cost: settingValue(m, 'cost') ?? '0' };
  }
  if (m.method_id === 'flat_rate') {
    const cost = settingValue(m, 'cost') ?? '0';
    // El costo puede ser una fórmula ([qty], [cost], [fee]): no la resolvemos, la avisamos.
    return /[[\]*]/.test(cost)
      ? { method: title, type: 'tarifa plana', cost: null, note: `El costo depende del carrito (${cost}); se calcula al pagar.` }
      : { method: title, type: 'tarifa plana', cost };
  }
  // Métodos de plugins (Andreani, OCA, etc.): la API no expone la cotización.
  return { method: title, type: 'cotizado por la tienda', cost: null, note: 'El costo se calcula en el checkout según el destino.' };
}

/** "Córdoba" / "cordoba" / "X" / "CABA" → código de provincia de WooCommerce. */
export function resolveStateCode(country: WooCountry | null, input: string | null | undefined): string | null {
  if (!input?.trim() || !country?.states?.length) return null;
  const norm = normalizeText(input.trim());
  const aliases: Record<string, string> = { caba: 'C', 'capital federal': 'C', 'ciudad de buenos aires': 'C' };
  if (country.code.toUpperCase() === 'AR' && aliases[norm]) return aliases[norm];
  const byCode = country.states.find((s) => s.code.toLowerCase() === norm);
  if (byCode) return byCode.code;
  const byName = country.states.find((s) => normalizeText(s.name) === norm);
  if (byName) return byName.code;
  const partial = country.states.filter((s) => normalizeText(s.name).includes(norm) || norm.includes(normalizeText(s.name)));
  return partial.length === 1 ? partial[0].code : null;
}

// ── Estado del pedido ───────────────────────────────────────────────────────

// Estados estándar de WooCommerce, escritos para el comprador.
const ORDER_STATUS: Record<string, { estado: string; detalle: string }> = {
  pending: { estado: 'Pendiente de pago', detalle: 'El pedido está creado pero todavía no se registró el pago.' },
  'on-hold': { estado: 'En espera', detalle: 'La tienda está esperando confirmar el pago (por ejemplo, una transferencia).' },
  processing: { estado: 'En preparación', detalle: 'El pago está confirmado y la tienda está preparando el pedido.' },
  completed: { estado: 'Completado', detalle: 'La tienda dio el pedido por completado (enviado o entregado).' },
  cancelled: { estado: 'Cancelado', detalle: 'El pedido fue cancelado.' },
  refunded: { estado: 'Reembolsado', detalle: 'El pedido fue reembolsado.' },
  failed: { estado: 'Pago fallido', detalle: 'El pago no se pudo completar.' },
  'checkout-draft': { estado: 'Sin finalizar', detalle: 'La compra quedó a mitad de camino y no se confirmó.' },
};

/**
 * ¿El pedido es de quien pregunta? El comprador tiene que dar el email con el que compró
 * además del número: el número solo se adivina (son correlativos).
 */
export function orderBelongsTo(order: WooOrder, email: string): boolean {
  const expected = order.billing?.email?.trim().toLowerCase();
  return Boolean(expected) && expected === email.trim().toLowerCase();
}

/**
 * Estado de un pedido para contestarle al comprador. Aunque se verifica el email, NO
 * devolvemos datos personales (nombre, email, teléfono, dirección exacta): el agente no
 * los necesita para contestar y así no quedan en la conversación. La ciudad alcanza
 * para confirmar el destino.
 */
export function shapeOrderStatus(order: WooOrder, notes: WooOrderNote[]): Record<string, unknown> {
  const status = order.status ?? '';
  const known = ORDER_STATUS[status];
  const shippingLine = order.shipping_lines?.[0];
  const city = order.shipping?.city || order.billing?.city || null;
  const unpaid = status === 'pending' || status === 'failed';
  return {
    found: true,
    order_number: order.number ?? String(order.id),
    status: known?.estado ?? status,
    detail: known?.detalle ?? null,
    created: order.date_created?.slice(0, 10) ?? null,
    paid: order.date_paid?.slice(0, 10) ?? null,
    completed: order.date_completed?.slice(0, 10) ?? null,
    items: (order.line_items ?? []).map((li) => ({ name: li.name ?? null, quantity: li.quantity ?? 1, total: li.total ?? null })),
    total: order.total ?? null,
    currency: order.currency ?? null,
    payment_method: order.payment_method_title || null,
    shipping: shippingLine ? { method: shippingLine.method_title ?? null, cost: shippingLine.total ?? null, city } : city ? { city } : null,
    ...(unpaid && order.payment_url ? { payment_url: order.payment_url } : {}),
    refunds: (order.refunds ?? []).map((r) => ({ amount: (r.total ?? '').replace(/^-/, ''), reason: r.reason || null })),
    notes_from_store: notes
      .map((n) => ({ date: n.date_created?.slice(0, 10) ?? null, note: stripHtml(n.note, 500) ?? '' }))
      .filter((n) => n.note),
  };
}
