import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { woocommerceService } from '../services/woocommerce.service';
import { WooError } from '../services/woocommerce-api.service';

const errorResponseSchema = z.object({ error: z.string() });
const clientIdSchema = z.coerce.number().int().positive();

/** WooError trae un mensaje pensado para el usuario/agente; el resto se loguea y se generaliza. */
function sendError(request: FastifyRequest, reply: FastifyReply, e: unknown, fallback: string) {
  if (e instanceof WooError) {
    return reply.status(e.status >= 500 ? 502 : e.status).send({ error: e.message });
  }
  request.log.error({ err: e }, fallback);
  return reply.status(500).send({ error: fallback });
}

export async function woocommerceRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/woocommerce/status?client_id=
  r.get(
    '/status',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Estado de conexión de WooCommerce para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: clientIdSchema }),
        response: {
          200: z.object({
            connected: z.boolean(),
            store_url: z.string().nullable(),
            store_name: z.string().nullable(),
            can_write: z.boolean(),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const conn = await woocommerceService.getConnection(request.query.client_id);
      return {
        connected: Boolean(conn),
        store_url: conn?.store_url ?? null,
        store_name: conn?.store_name ?? null,
        can_write: Boolean(conn?.key_permissions?.includes('write')),
      };
    },
  );

  // POST /api/woocommerce/authorize-url — paso 1 del botón "Conectar": valida que en la
  // URL haya un WooCommerce y devuelve a dónde mandar al usuario para autorizar.
  r.post(
    '/authorize-url',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'URL de autorización de WooCommerce (/wc-auth/v1/authorize) para la tienda indicada',
        security: [{ InternalToken: [] }],
        body: z.object({ client_id: clientIdSchema, store_url: z.string().min(3) }),
        response: {
          200: z.object({ authorize_url: z.string(), store_url: z.string() }),
          400: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        return await woocommerceService.buildAuthorizeUrl(request.body.client_id, request.body.store_url);
      } catch (e) {
        return sendError(request, reply, e, 'No se pudo iniciar la conexión con WooCommerce.');
      }
    },
  );

  // POST /api/woocommerce/connect — conexión manual con claves pegadas por el cliente.
  // Se validan contra la tienda antes de guardar, para que una clave mal copiada falle
  // en el dashboard y no cuando un comprador pregunta.
  r.post(
    '/connect',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Guarda (previa validación) las claves de la REST API de WooCommerce',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: clientIdSchema,
          store_url: z.string().min(3),
          consumer_key: z.string().min(10),
          consumer_secret: z.string().min(10),
        }),
        response: {
          200: z.object({
            connected: z.literal(true),
            store_url: z.string(),
            store_name: z.string().nullable(),
            can_write: z.boolean(),
          }),
          400: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const saved = await woocommerceService.saveConnection({
          clientId: request.body.client_id,
          storeUrl: request.body.store_url,
          consumerKey: request.body.consumer_key,
          consumerSecret: request.body.consumer_secret,
        });
        return { connected: true as const, ...saved };
      } catch (e) {
        return sendError(request, reply, e, 'No se pudo conectar WooCommerce.');
      }
    },
  );

  // POST /api/woocommerce/disconnect — olvida las claves. La revocación real se hace
  // en WooCommerce → Ajustes → Avanzado → REST API.
  r.post(
    '/disconnect',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Borra la conexión de WooCommerce del cliente',
        security: [{ InternalToken: [] }],
        body: z.object({ client_id: clientIdSchema }),
        response: { 200: z.object({ ok: z.literal(true) }), 500: errorResponseSchema },
      },
    },
    async (request) => {
      await woocommerceService.deleteConnection(request.body.client_id);
      return { ok: true as const };
    },
  );

  // GET /api/woocommerce/products?client_id=&query= — la consume la tool search_products.
  r.get(
    '/products',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Productos (cacheado 1h) con filtro opcional por texto',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: clientIdSchema, query: z.string().optional() }),
        response: { 200: z.unknown(), 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        return await woocommerceService.searchProducts(request.query.client_id, request.query.query);
      } catch (e) {
        return sendError(request, reply, e, 'No se pudieron leer los productos de WooCommerce.');
      }
    },
  );

  // POST /api/woocommerce/checkout — la consume la tool create_checkout. El `tool_id`
  // trae la config de envío que eligió el cliente en el dashboard.
  r.post(
    '/checkout',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Crea un pedido pendiente de pago y devuelve el link para pagarlo',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: clientIdSchema,
          tool_id: z.coerce.number().int().positive(),
          name: z.string().min(1),
          lastname: z.string().optional(),
          email: z.string().email(),
          phone: z.string().optional(),
          address: z
            .object({
              address_1: z.string().optional(),
              address_2: z.string().optional(),
              city: z.string().optional(),
              state: z.string().optional(),
              postcode: z.string().optional(),
              country: z.string().optional(),
            })
            .optional(),
          products: z
            .array(
              z.object({
                product_id: z.coerce.number().int().positive(),
                variation_id: z.coerce.number().int().positive().optional(),
                quantity: z.coerce.number().int().positive(),
              }),
            )
            .min(1),
          note: z.string().optional(),
        }),
        response: {
          200: z.object({
            payment_url: z.string().nullable(),
            order_id: z.number(),
            order_number: z.string(),
            total: z.string().nullable(),
            currency: z.string().nullable(),
            shipping: z.object({ title: z.string(), cost: z.number() }).nullable(),
          }),
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { client_id, tool_id, ...input } = request.body;
      try {
        return await woocommerceService.createCheckout(client_id, tool_id, input);
      } catch (e) {
        return sendError(request, reply, e, 'No se pudo crear el pedido en WooCommerce.');
      }
    },
  );
}
