import { FastifyInstance, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { composioService, ComposioNotConnectedError } from '../services/composio.service';

const errorResponseSchema = z.object({ error: z.string() });

// Mapea errores a HTTP: 409 si el cliente no conectó el toolkit, 4xx si Composio
// devuelve un error de la API con status, 502 para el resto.
function handleError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ComposioNotConnectedError) {
    return reply.status(409).send({ error: e.message });
  }
  const msg = (e as Error)?.message ?? 'Error desconocido';
  const ce = e as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  const raw = ce.response?.status ?? ce.status ?? ce.statusCode;
  const code = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(code) && code >= 400 && code < 500) {
    return reply.status(code).send({ error: msg });
  }
  return reply.status(502).send({ error: msg });
}

export async function composioRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/composio/toolkits → catálogo de toolkits (browse en la UI).
  r.get(
    '/toolkits',
    {
      schema: {
        tags: ['composio'],
        summary: 'Lista los toolkits disponibles en Composio',
        security: [{ InternalToken: [] }],
        response: { 200: z.unknown(), 502: errorResponseSchema },
      },
    },
    async (_request, reply) => {
      try {
        const toolkits = await composioService.listToolkits();
        return { toolkits };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/composio/tools?toolkit=&search=&limit= → tools de un toolkit (con schema).
  r.get(
    '/tools',
    {
      schema: {
        tags: ['composio'],
        summary: 'Lista las tools de un toolkit (slug + descripción + inputSchema)',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          toolkit: z.string().min(1),
          search: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
        response: { 200: z.unknown(), 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { toolkit, search, limit } = request.query;
        const tools = await composioService.listTools(toolkit, search, limit);
        return { tools, count: tools.length };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/composio/tools/:slug → una tool por slug (para snapshotear su inputSchema).
  r.get(
    '/tools/:slug',
    {
      schema: {
        tags: ['composio'],
        summary: 'Devuelve una tool de Composio por slug',
        security: [{ InternalToken: [] }],
        params: z.object({ slug: z.string().min(1) }),
        response: { 200: z.unknown(), 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        return await composioService.getTool(request.params.slug);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/composio/connections?client_id= → slugs de toolkits conectados (para el catálogo).
  r.get(
    '/connections',
    {
      schema: {
        tags: ['composio'],
        summary: 'Toolkits con cuenta ACTIVE para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: { 200: z.object({ toolkits: z.array(z.string()) }), 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const toolkits = await composioService.listConnectedToolkits(request.query.client_id);
        return { toolkits };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/composio/connect → inicia OAuth de un toolkit para un cliente.
  r.post(
    '/connect',
    {
      schema: {
        tags: ['composio'],
        summary: 'Inicia la conexión de un toolkit (devuelve la redirectUrl hosted)',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          toolkit: z.string().min(1),
          callback_url: z.string().url().optional(),
        }),
        response: {
          200: z.object({ redirect_url: z.string().nullable(), connection_id: z.string() }),
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, toolkit, callback_url } = request.body;
        const { redirectUrl, connectionId } = await composioService.initiateConnection(
          client_id,
          toolkit,
          callback_url,
        );
        return { redirect_url: redirectUrl, connection_id: connectionId };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/composio/status?client_id=&toolkit=
  r.get(
    '/status',
    {
      schema: {
        tags: ['composio'],
        summary: 'Estado de conexión de un toolkit para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          toolkit: z.string().min(1),
        }),
        response: {
          200: z.object({ connected: z.boolean(), account_id: z.string().nullable() }),
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, toolkit } = request.query;
        const { connected, accountId } = await composioService.connectionStatus(client_id, toolkit);
        return { connected, account_id: accountId };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/composio/disconnect → borra las cuentas del cliente para el toolkit.
  r.post(
    '/disconnect',
    {
      schema: {
        tags: ['composio'],
        summary: 'Desconecta un toolkit de un cliente',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          toolkit: z.string().min(1),
        }),
        response: { 200: z.object({ ok: z.boolean() }), 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, toolkit } = request.body;
        await composioService.disconnect(client_id, toolkit);
        return { ok: true };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/composio/execute → ejecuta una tool (lo llama runComposio del dashboard).
  r.post(
    '/execute',
    {
      schema: {
        tags: ['composio'],
        summary: 'Ejecuta una tool de Composio para un cliente',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          toolkit: z.string().min(1),
          slug: z.string().min(1),
          arguments: z.record(z.unknown()).default({}),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, toolkit, slug, arguments: args } = request.body;
        const data = await composioService.execute(client_id, toolkit, slug, args);
        return { data };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );
}
