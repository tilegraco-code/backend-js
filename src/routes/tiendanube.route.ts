import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { tiendanubeService } from '../services/tiendanube.service';
import { filterByQuery } from '../lib/text-search';

const errorResponseSchema = z.object({ error: z.string() });
// Tienda que eligió la tool (agent_tools.config.connection_id). Sin él, la principal.
const connectionIdSchema = z.coerce.number().int().positive().optional();

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
  id?: number;
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
  // variant_id es lo que se usa para armar un checkout (create_checkout).
  if (variants.length <= 1) {
    const v = variants[0] ?? {};
    return {
      ...base,
      variant_id: v.id ?? null,
      price: v.price ?? null,
      promotional_price: v.promotional_price ?? null,
      stock: variantStock(v),
    };
  }

  // Multi-variante → listar cada variante con sus opciones.
  return {
    ...base,
    variants: variants.map((v) => ({
      variant_id: v.id ?? null,
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
        summary: 'Tiendas de TiendaNube conectadas de un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          // Los campos sueltos son de la principal (compat con el dashboard de una sola tienda).
          200: z.object({
            connected: z.boolean(),
            store_name: z.string().nullable(),
            store_url: z.string().nullable(),
            connections: z.array(
              z.object({
                id: z.number(),
                store_id: z.number(),
                store_name: z.string().nullable(),
                store_url: z.string().nullable(),
                connected_at: z.string(),
              }),
            ),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const all = await tiendanubeService.listConnections(request.query.client_id);
      const main = all[0];
      return {
        connected: Boolean(main),
        store_name: main?.store_name ?? null,
        store_url: main?.store_url ?? null,
        connections: all.map((c) => ({
          id: c.id,
          store_id: c.store_id,
          store_name: c.store_name,
          store_url: c.store_url,
          connected_at: c.connected_at,
        })),
      };
    },
  );

  // GET /api/tiendanube/products?client_id=&query=&connection_id=
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
          connection_id: connectionIdSchema,
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, connection_id } = request.query;
        const [{ payload, cached, fetched_at }, currency] = await Promise.all([
          tiendanubeService.getCachedResource(client_id, 'products', connection_id),
          tiendanubeService.getCurrency(client_id, connection_id),
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

  // GET /api/tiendanube/orders?client_id=&status=&connection_id=
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
          connection_id: connectionIdSchema,
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { payload, cached, fetched_at } = await tiendanubeService.getCachedResource(
          request.query.client_id,
          'orders',
          request.query.connection_id,
        );
        const items = filterByStatus(payload, request.query.status);
        return { items, count: items.length, cached, fetched_at };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );

  // POST /api/tiendanube/checkout — crea un draft order y devuelve checkout_url.
  r.post(
    '/checkout',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Crea un carrito listo para pagar (draft order) y devuelve el checkout_url',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          connection_id: connectionIdSchema,
          name: z.string().min(1),
          lastname: z.string().optional(),
          email: z.string().email(),
          phone: z.string().optional(),
          products: z
            .array(
              z.object({
                variant_id: z.coerce.number().int().positive(),
                quantity: z.coerce.number().int().positive(),
              }),
            )
            .min(1),
          note: z.string().optional(),
        }),
        response: {
          200: z.object({
            checkout_url: z.string().nullable(),
            draft_order_id: z.number(),
            total: z.string().nullable(),
            discount: z.string().nullable(),
            discount_coupon: z.string().nullable(),
            discount_gateway: z.string().nullable(),
            currency: z.string().nullable(),
          }),
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, connection_id, ...input } = request.body;
        const result = await tiendanubeService.createCheckout(client_id, input, connection_id);
        return result;
      } catch (e) {
        return reply.status(400).send({ error: (e as Error).message });
      }
    },
  );

  // GET /api/tiendanube/carts?client_id=&connection_id=
  r.get(
    '/carts',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Carritos / checkouts abandonados (cacheado 1h)',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          connection_id: connectionIdSchema,
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { payload, cached, fetched_at } = await tiendanubeService.getCachedResource(
          request.query.client_id,
          'carts',
          request.query.connection_id,
        );
        return { items: payload, count: payload.length, cached, fetched_at };
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );
}
