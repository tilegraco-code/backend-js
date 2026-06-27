import { FastifyInstance, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { googleApiService, GoogleNotConnectedError } from '../services/google-api.service';
import { googleService } from '../services/google.service';
import { googleSheetsService } from '../services/google-sheets.service';
import { googleCalendarService } from '../services/google-calendar.service';

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

  // ---------- CALENDAR ----------

  const calIdSchema = z.string().min(1).default('primary');

  // GET /api/google/calendar/events?client_id=&calendar_id=&time_min=&time_max=
  r.get(
    '/calendar/events',
    {
      schema: {
        tags: ['google'],
        summary: 'Lista eventos del calendario en un rango',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          calendar_id: calIdSchema,
          time_min: z.string().min(1),
          time_max: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, calendar_id, time_min, time_max } = request.query;
        const events = await googleCalendarService.listEvents(client_id, calendar_id, time_min, time_max);
        return { events, count: events.length };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // GET /api/google/calendar/availability?client_id=&calendar_id=&time_min=&time_max=
  r.get(
    '/calendar/availability',
    {
      schema: {
        tags: ['google'],
        summary: 'Disponibilidad (bloques ocupados) en un rango',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          calendar_id: calIdSchema,
          time_min: z.string().min(1),
          time_max: z.string().min(1),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, calendar_id, time_min, time_max } = request.query;
        return await googleCalendarService.checkAvailability(client_id, calendar_id, time_min, time_max);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // POST /api/google/calendar/events
  r.post(
    '/calendar/events',
    {
      schema: {
        tags: ['google'],
        summary: 'Crea un evento en el calendario',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          calendar_id: calIdSchema,
          summary: z.string().min(1),
          description: z.string().optional(),
          location: z.string().optional(),
          start: z.string().min(1),
          end: z.string().min(1),
          timezone: z.string().optional(),
          attendees: z.array(z.string().email()).optional(),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, calendar_id, ...input } = request.body;
        return await googleCalendarService.createEvent(client_id, calendar_id, input);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // PATCH /api/google/calendar/events/:id
  r.patch(
    '/calendar/events/:id',
    {
      schema: {
        tags: ['google'],
        summary: 'Edita un evento existente',
        security: [{ InternalToken: [] }],
        params: z.object({ id: z.string().min(1) }),
        body: z.object({
          client_id: z.coerce.number().int().positive(),
          calendar_id: calIdSchema,
          summary: z.string().optional(),
          description: z.string().optional(),
          location: z.string().optional(),
          start: z.string().optional(),
          end: z.string().optional(),
          timezone: z.string().optional(),
          attendees: z.array(z.string().email()).optional(),
        }),
        response: { 200: z.unknown(), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, calendar_id, ...input } = request.body;
        return await googleCalendarService.updateEvent(client_id, calendar_id, request.params.id, input);
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );

  // DELETE /api/google/calendar/events/:id?client_id=&calendar_id=
  r.delete(
    '/calendar/events/:id',
    {
      schema: {
        tags: ['google'],
        summary: 'Cancela (borra) un evento',
        security: [{ InternalToken: [] }],
        params: z.object({ id: z.string().min(1) }),
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          calendar_id: calIdSchema,
        }),
        response: { 200: z.object({ ok: z.boolean() }), 409: errorResponseSchema, 502: errorResponseSchema },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, calendar_id } = request.query;
        await googleCalendarService.deleteEvent(client_id, calendar_id, request.params.id);
        return { ok: true };
      } catch (e) {
        return handleError(reply, e);
      }
    },
  );
}
