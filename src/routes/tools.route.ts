import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  executeHttpTool,
  HttpToolError,
  loadHttpTool,
  type HttpToolConfig,
} from '../services/http-tool.service';

const errorResponseSchema = z.object({ error: z.string() });
const resultSchema = z.object({ ok: z.boolean(), status: z.number(), body: z.string() });

const paramSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'number', 'boolean']),
  description: z.string(),
  required: z.boolean(),
  location: z.enum(['path', 'query', 'body']),
});
const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer') }),
  z.object({ type: z.literal('header'), name: z.string().min(1) }),
  z.object({ type: z.literal('query'), name: z.string().min(1) }),
  z.object({ type: z.literal('basic'), username: z.string() }),
]);
const configSchema = z.object({
  url: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  headers: z.record(z.string(), z.string()).optional(),
  query_params: z.record(z.string(), z.string()).optional(),
  body_template: z.string().optional(),
  params: z.array(paramSchema).optional(),
  auth: authSchema.optional(),
});

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/tools/http/run — lo llama el runtime cuando el agente usa una tool HTTP.
  // Errores de la API del cliente (4xx/5xx) vuelven como 200 con ok=false: son
  // información para el modelo, no una falla de este endpoint.
  r.post(
    '/http/run',
    {
      schema: {
        tags: ['tools'],
        summary: 'Ejecuta una tool HTTP del cliente (el secreto se resuelve acá)',
        security: [{ InternalToken: [] }],
        body: z.object({
          tool_id: z.coerce.number().int().positive(),
          client_id: z.coerce.number().int().positive(),
          args: z.record(z.string(), z.unknown()).default({}),
        }),
        response: { 200: resultSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { tool_id, client_id, args } = request.body;
      try {
        const tool = await loadHttpTool(tool_id, client_id);
        if (!tool.enabled) return reply.status(400).send({ error: 'La herramienta está desactivada.' });
        return await executeHttpTool(tool.config, tool.secret, args);
      } catch (err) {
        const f = toFailure(err, request.log, { tool_id, client_id });
        return f.code === 200 ? f.result : reply.status(f.code).send({ error: f.error });
      }
    },
  );

  // POST /api/tools/http/test — botón "Probar" del dashboard, con la config SIN guardar.
  // Si no viene `secret` y viene `tool_id`, usa el guardado: al editar, el
  // navegador no conoce el secreto (ve ••••) y aun así tiene que poder probar.
  r.post(
    '/http/test',
    {
      schema: {
        tags: ['tools'],
        summary: 'Prueba una config de tool HTTP antes de guardarla',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          tool_id: z.coerce.number().int().positive().optional(),
          config: configSchema,
          secret: z.string().optional(),
          args: z.record(z.string(), z.unknown()).default({}),
        }),
        response: { 200: resultSchema, 400: errorResponseSchema, 404: errorResponseSchema, 500: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { client_id, tool_id, config, args } = request.body;
      try {
        let secret = request.body.secret ?? null;
        if (!secret && tool_id) secret = (await loadHttpTool(tool_id, client_id)).secret;
        return await executeHttpTool(config as HttpToolConfig, secret, args);
      } catch (err) {
        const f = toFailure(err, request.log, { tool_id, client_id });
        return f.code === 200 ? f.result : reply.status(f.code).send({ error: f.error });
      }
    },
  );
}

type Failure = { code: 200; result: { ok: false; status: number; body: string } } | { code: 400 | 404 | 500; error: string };

function toFailure(err: unknown, log: { error: (o: object, m: string) => void }, ctx: Record<string, unknown>): Failure {
  if (err instanceof HttpToolError) {
    // 502/504 (la API del cliente no respondió) se informan como resultado para el modelo.
    if (err.status === 502 || err.status === 504) {
      return { code: 200, result: { ok: false, status: err.status, body: err.message } };
    }
    return { code: err.status === 404 ? 404 : err.status >= 500 ? 500 : 400, error: err.message };
  }
  log.error({ err, ...ctx }, 'http tool: error inesperado');
  return { code: 500, error: 'Error inesperado ejecutando la herramienta.' };
}
