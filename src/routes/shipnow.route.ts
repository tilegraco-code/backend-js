import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { shipnowService } from '../services/shipnow.service';

const errorResponseSchema = z.object({ error: z.string() });
// Opcional en todas las rutas: sin él se usa la cuenta principal (la más vieja).
const connectionIdSchema = z.coerce.number().int().positive().optional();

export async function shipnowRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/shipnow/status?client_id=
  r.get(
    '/status',
    {
      schema: {
        tags: ['shipnow'],
        summary: 'Cuentas de shipnow conectadas de un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          // Los campos sueltos son de la principal (compat con el dashboard de una sola cuenta).
          200: z.object({
            connected: z.boolean(),
            account_name: z.string().nullable(),
            connected_at: z.string().nullable(),
            connections: z.array(
              z.object({ id: z.number(), account_name: z.string().nullable(), connected_at: z.string() }),
            ),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const all = await shipnowService.listConnections(request.query.client_id);
      const main = all[0];
      return {
        connected: Boolean(main),
        account_name: main?.account_name ?? null,
        connected_at: main?.connected_at ?? null,
        connections: all.map((c) => ({ id: c.id, account_name: c.account_name, connected_at: c.connected_at })),
      };
    },
  );

  // POST /api/shipnow/connect — guarda el token de una cuenta del cliente. Con
  // connection_id reemplaza el token de esa cuenta; sin él agrega una.
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
          connection_id: connectionIdSchema,
        }),
        response: {
          200: z.object({ connected: z.literal(true), id: z.number(), account_name: z.string().nullable() }),
          400: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { id, account_name } = await shipnowService.saveConnection(
          request.body.client_id,
          request.body.api_token.trim(),
          request.body.connection_id,
        );
        return { connected: true as const, id, account_name };
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
        summary: 'Borra una cuenta de shipnow del cliente (sin connection_id, la principal)',
        security: [{ InternalToken: [] }],
        body: z.object({ client_id: z.coerce.number().int().positive(), connection_id: connectionIdSchema }),
        response: { 200: z.object({ ok: z.literal(true) }), 500: errorResponseSchema },
      },
    },
    async (request) => {
      await shipnowService.deleteConnection(request.body.client_id, request.body.connection_id);
      return { ok: true as const };
    },
  );

  // GET /api/shipnow/orders?client_id=&order_number=&connection_id=
  // Es el endpoint que consume la tool del agente (runtime LangGraph). connection_id es
  // la cuenta que eligió la tool (agent_tools.config.connection_id).
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
          connection_id: connectionIdSchema,
        }),
        response: { 200: z.unknown(), 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, order_number, connection_id } = request.query;
        return await shipnowService.findOrder(client_id, order_number, connection_id);
      } catch (e) {
        return reply.status(404).send({ error: (e as Error).message });
      }
    },
  );
}
