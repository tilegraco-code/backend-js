// Shaping del catálogo de WooCommerce a la forma compacta que ve el agente. Puro
// (sin red ni DB) para poder testearlo.
import type { WooProduct, WooVariation } from './woocommerce-api.service';

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
