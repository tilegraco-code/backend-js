import { FastifyInstance, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { googleApiService, GoogleNotConnectedError } from '../services/google-api.service';
import { googleService } from '../services/google.service';
import { googleSheetsService } from '../services/google-sheets.service';

const errorResponseSchema = z.object({ error: z.string() });

// Mapea errores a HTTP: 409 si el cliente no conectó Google, 502 para errores de la
// API de Google, 500 para el resto. Devuelve la respuesta ya enviada.
function handleError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof GoogleNotConnectedError) {
    return reply.status(409).send({ error: e.message });
  }
  const msg = (e as Error)?.message ?? 'Error desconocido';
  // invalid_grant = el cliente revocó el acceso → hay que reconectar.
  if (msg.includes('invalid_grant')) {
    return reply.status(409).send({
      error: 'La cuenta de Google se desconectó. Reconectala desde el dashboard.',
    });
  }
  // Errores 4xx de la API de Google (rango/tab inválido, sin permiso, no existe):
  // devolver el status real, NO 502. Con 5xx el proxy reemplaza el body y se pierde
  // el mensaje; con 4xx el detalle llega al dashboard/agente y se puede autocorregir.
  const ge = e as { code?: unknown; status?: unknown; response?: { status?: unknown } };
  const raw = ge.response?.status ?? ge.status ?? ge.code;
  const gcode = typeof raw === 'number' ? raw : Number(raw);
  if (Number.isFinite(gcode) && gcode >= 400 && gcode < 500) {
    return reply.status(gcode).send({ error: msg });
  }
  return reply.status(502).send({ error: msg });
}

// Cell value que aceptamos al escribir (string o número).
const cellSchema = z.union([z.string(), z.number()]);
const valuesSchema = z.array(z.array(cellSchema)).min(1);

export async function googleRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/google/status?client_id=
  r.get(
    '/status',
    {
      schema: {
        tags: ['google'],
        summary: 'Estado de conexión de Google para un cliente',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          200: z.object({
            connected: z.boolean(),
            google_email: z.string().nullable(),
            scope: z.string().nullable(),
            connected_at: z.string().nullable(),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const conn = await googleService.getConnection(request.query.client_id);
      return {
        connected: Boolean(conn),
        google_email: conn?.google_email ?? null,
        scope: conn?.scope ?? null,
        connected_at: conn?.connected_at ?? null,
      };
    },
  );

  // DELETE /api/google/connection?client_id= → revoca y borra la conexión.
  r.delete(
    '/connection',
    {
      schema: {
        tags: ['google'],
        summary: 'Desconecta Google de un cliente (revoca token + borra fila)',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: { 200: z.object({ ok: z.boolean() }), 500: errorResponseSchema },
      },
    },
    async (request) => {
      const conn = await googleService.getConnection(request.query.client_id);
      if (conn?.refresh_token) await googleApiService.revoke(conn.refresh_token);
      await googleService.deleteConnection(request.query.client_id);
      return { ok: true };
    },
  );

  // GET /api/google/sheets/read?client_id=&spreadsheet_id=&range=
  r.get(
    '/sheets/read',
    {
      schema: {
        tags: ['google'],
        summary: 'Lee un rango de un Google Sheet',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          spreadsheet_id: z.string().min(1),
          range: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, spreadsheet_id, range } = request.query;
        return await googleSheetsService.read(client_id, spreadsheet_id, range);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/google/sheets/append
  r.post(
    '/sheets/append',
    {
      schema: {
        tags: ['google'],
        summary: 'Agrega filas al final de un Google Sheet',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          spreadsheet_id: z.string().min(1),
          range: z.string().min(1),
          values: valuesSchema,
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, spreadsheet_id, range, values } = request.body;
        return await googleSheetsService.append(client_id, spreadsheet_id, range, values);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/google/sheets/update
  r.post(
    '/sheets/update',
    {
      schema: {
        tags: ['google'],
        summary: 'Actualiza celdas de un rango de un Google Sheet',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          spreadsheet_id: z.string().min(1),
          range: z.string().min(1),
          values: valuesSchema,
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, spreadsheet_id, range, values } = request.body;
        return await googleSheetsService.update(client_id, spreadsheet_id, range, values);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/google/sheets/create
  r.post(
    '/sheets/create',
    {
      schema: {
        tags: ['google'],
        summary: 'Crea un Google Sheet nuevo',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          title: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, title } = request.body;
        return await googleSheetsService.create(client_id, title);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/google/sheets/tabs?client_id=&spreadsheet_id= → nombres de las pestañas.
  r.get(
    '/sheets/tabs',
    {
      schema: {
        tags: ['google'],
        summary: 'Lista los nombres de las pestañas de un Google Sheet',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          spreadsheet_id: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const tabs = await googleSheetsService.listTabs(
          request.query.client_id,
          request.query.spreadsheet_id,
        );
        return { tabs };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/google/access-token?client_id= → token corto para el Google Picker (browser).
  r.get(
    '/access-token',
    {
      schema: {
        tags: ['google'],
        summary: 'Access token vigente para el Google Picker (uso en el navegador)',
        security: [{ InternalToken: [] }],
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { token, expiry_date } = await googleApiService.accessToken(request.query.client_id);
        return { access_token: token, expiry_date };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/google/sheets/find?client_id=&name=
  r.get(
    '/sheets/find',
    {
      schema: {
        tags: ['google'],
        summary: 'Busca Google Sheets por nombre (solo archivos creados/abiertos por la app)',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          name: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, name } = request.query;
        const files = await googleSheetsService.findByName(client_id, name);
        return { files, count: files.length };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );
}
