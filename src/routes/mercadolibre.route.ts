import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mercadolibreQuestionsService } from '../services/mercadolibre-questions.service';
import { MlToolError, mercadolibreToolsService } from '../services/mercadolibre-tools.service';

const errorResponseSchema = z.object({ error: z.string() });
const clientIdSchema = z.coerce.number().int().positive();
// Cuenta que eligió la tool (agent_tools.config.ml_user_id). Sin ella, la principal.
const mlUserIdSchema = z.coerce.number().int().positive().optional();
const toolResponses = {
  200: z.unknown(),
  400: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  500: errorResponseSchema,
  502: errorResponseSchema,
};

/** MlToolError trae un mensaje pensado para el agente; el resto se loguea y se generaliza. */
function sendToolError(request: FastifyRequest, reply: FastifyReply, e: unknown) {
  if (e instanceof MlToolError) {
    return reply.status(e.status as 400 | 403 | 404 | 500 | 502).send({ error: e.message });
  }
  request.log.error({ err: e }, 'mercadolibre tools: error inesperado');
  return reply.status(500).send({ error: 'No se pudo consultar MercadoLibre.' });
}

/**
 * Rutas internas de MercadoLibre (Bearer interno). Las llama el dashboard, que no
 * tiene los tokens de ML: el acceso del usuario al client_id lo valida él antes.
 */
export async function mercadolibreRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/mercadolibre/questions/:questionId/answer → respuesta manual desde la tab del Inbox.
  r.post(
    '/questions/:questionId/answer',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Responde a mano una pregunta de una publicación (con la firma del canal)',
        security: [{ InternalToken: [] }],
        params: z.object({ questionId: z.coerce.number().int().positive() }),
        body: z.object({
          client_id: z.number().int().positive(),
          text: z.string().min(1),
        }),
        response: {
          200: z.object({ ok: z.literal(true), answer: z.string() }),
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await mercadolibreQuestionsService.answerManually(
        {
          clientId: request.body.client_id,
          questionId: request.params.questionId,
          text: request.body.text,
        },
        request.log,
      );
      if (!result.ok) {
        return reply.status(result.status as 400 | 404 | 409 | 502).send({ error: result.error });
      }
      return { ok: true as const, answer: result.answer };
    },
  );

  // ── Tools del agente (runtime LangGraph) ─────────────────────────────────
  // Solo lectura. Las usa cualquier agente del cliente con una cuenta de ML conectada,
  // tenga o no activo el canal.

  // GET /api/mercadolibre/tools/products?client_id=&query=&ml_user_id=
  r.get(
    '/tools/products',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Busca entre las publicaciones activas del vendedor',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: clientIdSchema,
          query: z.string().optional(),
          ml_user_id: mlUserIdSchema,
        }),
        response: toolResponses,
      },
    },
    async (request, reply) => {
      try {
        const { client_id, query, ml_user_id } = request.query;
        return await mercadolibreToolsService.searchProducts(client_id, query, ml_user_id);
      } catch (e) {
        return sendToolError(request, reply, e);
      }
    },
  );

  // GET /api/mercadolibre/tools/product?client_id=&item_id=&ml_user_id=
  r.get(
    '/tools/product',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Ficha de una publicación: precio, atributos, garantía, envío y descripción',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: clientIdSchema, item_id: z.string().min(1), ml_user_id: mlUserIdSchema }),
        response: toolResponses,
      },
    },
    async (request, reply) => {
      try {
        const { client_id, item_id, ml_user_id } = request.query;
        return await mercadolibreToolsService.getProductDetail(client_id, item_id, ml_user_id);
      } catch (e) {
        return sendToolError(request, reply, e);
      }
    },
  );

  // GET /api/mercadolibre/tools/stock?client_id=&item_id=&ml_user_id=
  r.get(
    '/tools/stock',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Stock de una publicación, total y por variante',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: clientIdSchema, item_id: z.string().min(1), ml_user_id: mlUserIdSchema }),
        response: toolResponses,
      },
    },
    async (request, reply) => {
      try {
        const { client_id, item_id, ml_user_id } = request.query;
        return await mercadolibreToolsService.getStock(client_id, item_id, ml_user_id);
      } catch (e) {
        return sendToolError(request, reply, e);
      }
    },
  );

  // GET /api/mercadolibre/tools/shipping-cost?client_id=&item_id=&zip_code=&ml_user_id=
  r.get(
    '/tools/shipping-cost',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Costo y plazo de envío de una publicación a un código postal',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: clientIdSchema,
          item_id: z.string().min(1),
          zip_code: z.string().min(1),
          ml_user_id: mlUserIdSchema,
        }),
        response: toolResponses,
      },
    },
    async (request, reply) => {
      try {
        const { client_id, item_id, zip_code, ml_user_id } = request.query;
        return await mercadolibreToolsService.getShippingCost(client_id, item_id, zip_code, ml_user_id);
      } catch (e) {
        return sendToolError(request, reply, e);
      }
    },
  );

  // GET /api/mercadolibre/tools/{order,shipment,invoice}?client_id=&order_number=&ml_user_id=
  const saleQuery = z.object({
    client_id: clientIdSchema,
    order_number: z.string().min(1),
    ml_user_id: mlUserIdSchema,
  });
  const saleTools = [
    { path: '/tools/order', summary: 'Estado de una venta (pago y productos) por número de venta', run: 'getOrderStatus' },
    { path: '/tools/shipment', summary: 'Estado del envío de una venta por número de venta', run: 'getShipmentStatus' },
    { path: '/tools/invoice', summary: 'Si la venta tiene la factura cargada', run: 'getInvoice' },
  ] as const;
  for (const t of saleTools) {
    r.get(
      t.path,
      {
        schema: {
          tags: ['mercadolibre'],
          summary: t.summary,
          security: [{ InternalToken: [] }],
          querystring: saleQuery,
          response: toolResponses,
        },
      },
      async (request, reply) => {
        try {
          const { client_id, order_number, ml_user_id } = request.query;
          return await mercadolibreToolsService[t.run](client_id, order_number, ml_user_id);
        } catch (e) {
          return sendToolError(request, reply, e);
        }
      },
    );
  }

  // GET /api/mercadolibre/tools/payment-methods?client_id=&ml_user_id=
  r.get(
    '/tools/payment-methods',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Medios de pago que acepta MercadoLibre en el país de la cuenta',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: clientIdSchema, ml_user_id: mlUserIdSchema }),
        response: toolResponses,
      },
    },
    async (request, reply) => {
      try {
        const { client_id, ml_user_id } = request.query;
        return await mercadolibreToolsService.getPaymentMethods(client_id, ml_user_id);
      } catch (e) {
        return sendToolError(request, reply, e);
      }
    },
  );
}
