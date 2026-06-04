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
        const { payload, cached, fetched_at } = await tiendanubeService.getCachedResource(
          request.query.client_id,
          'products',
        );
        const items = filterByQuery(payload, request.query.query);
        return { items, count: items.length, cached, fetched_at };
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
