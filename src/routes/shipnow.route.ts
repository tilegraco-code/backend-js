import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { shipnowService } from '../services/shipnow.service';

const errorResponseSchema = z.object({ error: z.string() });

export async function shipnowRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/shipnow/status?client_id=
  r.get(
    '/status',
    {
      schema: {
        tags: ['shipnow'],
        summary: 'Estado de conexión de shipnow para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          200: z.object({
            connected: z.boolean(),
            account_name: z.string().nullable(),
            connected_at: z.string().nullable(),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const conn = await shipnowService.getConnection(request.query.client_id);
      return {
        connected: Boolean(conn),
        account_name: conn?.account_name ?? null,
        connected_at: conn?.connected_at ?? null,
      };
    },
  );

  // POST /api/shipnow/connect — guarda el token del cliente.
  //
  // shipnow no tiene OAuth: el token lo pide el dueño de la cuenta por mail y lo
  // pega en el dashboard. Lo validamos contra la API antes de guardarlo para no
  // dejar una conexión rota que recién falle cuando un comprador pregunte.
  r.post(
    '/connect',
    {
      schema: {
        tags: ['shipnow'],
        summary: 'Guarda (previa validación) el token de API de shipnow del cliente',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          api_token: z.string().min(10),
        }),
        response: {
          200: z.object({ connected: z.literal(true), account_name: z.string().nullable() }),
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { account_name } = await shipnowService.saveConnection(
          request.body.client_id,
          request.body.api_token.trim(),
        );
        return { connected: true as const, account_name };
      } catch (e) {
        request.log.error({ err: e }, 'shipnow connect falló');
        return reply.status(400).send({
          error:
            'shipnow rechazó el token. Verificá que sea el token de la cuenta y que esté activo.',
        });
      }
    },
  );

  // POST /api/shipnow/disconnect — olvida el token guardado.
  // shipnow no expone revocación por API: se revoca desde shipnow, acá sólo
  // borramos lo que guardamos de este cliente.
  r.post(
    '/disconnect',
    {
      schema: {
        tags: ['shipnow'],
        summary: 'Borra la conexión de shipnow del cliente',
        security: [{ InternalToken: [] }],
        body: z.object({ client_id: z.coerce.number().int().positive() }),
        response: { 200: z.object({ ok: z.literal(true) }), 500: errorResponseSchema },
      },
    },
    async (request) => {
      await shipnowService.deleteConnection(request.body.client_id);
      return { ok: true as const };
    },
  );

  // GET /api/shipnow/orders?client_id=&order_number=
  // Es el endpoint que consume la tool del agente (runtime LangGraph).
  r.get(
    '/orders',
    {
      schema: {
        tags: ['shipnow'],
        summary: 'Estado del envío de un pedido, por número de orden de la tienda o ID de shipnow',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          order_number: z.string().min(1),
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        return await shipnowService.findOrder(request.query.client_id, request.query.order_number);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );
}
