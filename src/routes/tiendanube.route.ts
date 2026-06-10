import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { tiendanubeService } from '../services/tiendanube.service';

const errorResponseSchema = z.object({ error: z.string() });

// Filtro laxo por substring sobre el JSON del item (case-insensitive).
function filterByQuery(items: unknown[], query?: string): unknown[] {
  if (!query) return items;
  const q = query.toLowerCase();
  return items.filter((it) => JSON.stringify(it).toLowerCase().includes(q));
}

function filterByStatus(items: unknown[], status?: string): unknown[] {
  if (!status) return items;
  return items.filter(
    (it) => (it as { status?: unknown })?.status === status,
  );
}

// ---- Shaping de productos ----
// En TiendaNube el precio/stock viven en cada variant. Devolvemos una forma
// compacta (sin imágenes ni ruido) que expone lo que el agente necesita.

type I18n = string | Record<string, string> | null | undefined;

function localized(v: I18n): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v.es ?? v.pt ?? Object.values(v)[0] ?? null;
}

type RawVariant = {
  price?: string | null;
  promotional_price?: string | null;
  stock?: number | null;
  stock_management?: boolean;
  values?: I18n[];
};

type RawProduct = {
  id?: number;
  name?: I18n;
  canonical_url?: string | null;
  attributes?: I18n[];
  variants?: RawVariant[];
};

function variantStock(v: RawVariant): number | string {
  // stock_management === false → sin control de stock = ilimitado.
  if (v.stock_management === false) return 'ilimitado';
  return v.stock ?? 0;
}

function variantOptions(attributes: I18n[], v: RawVariant): string[] {
  const values = v.values ?? [];
  return values
    .map((val, i) => {
      const label = localized(attributes[i]);
      const value = localized(val);
      if (!value) return null;
      return label ? `${label}: ${value}` : value;
    })
    .filter((x): x is string => Boolean(x));
}

function shapeProduct(raw: RawProduct, currency: string | null): Record<string, unknown> {
  const variants = raw.variants ?? [];
  const attributes = raw.attributes ?? [];
  const base = {
    id: raw.id,
    name: localized(raw.name),
    url: raw.canonical_url ?? null,
    ...(currency ? { currency } : {}),
  };

  // 1 sola variante → aplanar precio/stock al top-level (caso producto simple).
  if (variants.length <= 1) {
    const v = variants[0] ?? {};
    return {
      ...base,
      price: v.price ?? null,
      promotional_price: v.promotional_price ?? null,
      stock: variantStock(v),
    };
  }

  // Multi-variante → listar cada variante con sus opciones.
  return {
    ...base,
    variants: variants.map((v) => ({
      options: variantOptions(attributes, v),
      price: v.price ?? null,
      promotional_price: v.promotional_price ?? null,
      stock: variantStock(v),
    })),
  };
}

function shapeProducts(items: unknown[], currency: string | null): Record<string, unknown>[] {
  return items.map((it) => shapeProduct(it as RawProduct, currency));
}

export async function tiendanubeRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/tiendanube/status?client_id=
  r.get(
    '/status',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Estado de conexión de TiendaNube para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          200: z.object({
            connected: z.boolean(),
            store_name: z.string().nullable(),
            store_url: z.string().nullable(),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const conn = await tiendanubeService.getConnection(request.query.client_id);
      return {
        connected: Boolean(conn),
        store_name: conn?.store_name ?? null,
        store_url: conn?.store_url ?? null,
      };
    },
  );

  // GET /api/tiendanube/products?client_id=&query=
  r.get(
    '/products',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Productos (cacheado 1h) con filtro opcional por texto',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          query: z.string().optional(),
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const [{ payload, cached, fetched_at }, currency] = await Promise.all([
          tiendanubeService.getCachedResource(request.query.client_id, 'products'),
          tiendanubeService.getCurrency(request.query.client_id),
        ]);
        // Compactar (saca imágenes, expone precio/stock/moneda de variants) y luego filtrar.
        const shaped = shapeProducts(payload, currency);
        const items = filterByQuery(shaped, request.query.query);
        return { items, count: items.length, cached, fetched_at, currency };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  // GET /api/tiendanube/orders?client_id=&status=
  r.get(
    '/orders',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Órdenes (cacheado 1h) con filtro opcional por estado',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          status: z.string().optional(),
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { payload, cached, fetched_at } = await tiendanubeService.getCachedResource(
          request.query.client_id,
          'orders',
        );
        const items = filterByStatus(payload, request.query.status);
        return { items, count: items.length, cached, fetched_at };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  // GET /api/tiendanube/carts?client_id=
  r.get(
    '/carts',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Carritos / checkouts abandonados (cacheado 1h)',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { payload, cached, fetched_at } = await tiendanubeService.getCachedResource(
          request.query.client_id,
          'carts',
        );
        return { items: payload, count: payload.length, cached, fetched_at };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );
}
