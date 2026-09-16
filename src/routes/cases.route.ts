import { FastifyInstance, FastifyReply } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CaseError, casesService } from '../services/cases.service';

// Datos del caso tal como los manda el agente: valores simples. Se normalizan contra la
// definición del tipo en cases.service (sanitizeData).
const dataSchema = z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]));

/**
 * Un CaseError es un problema de negocio que el agente tiene que poder explicar ("ya hay un caso
 * abierto"): va con su código y mensaje. Cualquier otra cosa es un 500 sin detalle interno.
 */
function handleError(err: unknown, reply: FastifyReply) {
  if (err instanceof CaseError) {
    const status = err.code === 'case_not_found' ? 404 : err.code === 'invalid_config' ? 500 : 409;
    return reply.status(status).send({ error: err.message, code: err.code, detail: err.detail ?? null });
  }
  reply.log.error({ err }, 'cases: error inesperado');
  return reply.status(500).send({ error: 'No se pudo completar la operación del caso', code: 'internal', detail: null });
}

export async function casesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/cases → abre un caso en un chat. Lo llama la tool abrir_caso del runtime.
  r.post(
    '/',
    {
      schema: {
        tags: ['cases'],
        summary: 'Abre un caso en un chat',
        security: [{ InternalToken: [] }],
        body: z.object({
          client_id: z.number().int().positive(),
          agent_id: z.number().int().positive(),
          chat_id: z.string().min(1),
          case_type: z.string().min(1),
          data: dataSchema.optional(),
        }),
      },
    },
    async (request, reply) => {
      const { client_id, agent_id, chat_id, case_type, data } = request.body;
      try {
        const view = await casesService.open(
          { clientId: client_id, agentId: agent_id, chatId: chat_id, caseType: case_type, data },
          request.log,
        );
        return reply.status(201).send({ case: view });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // GET /api/cases/active?client_id=&chat_id= → caso activo del chat (o null).
  r.get(
    '/active',
    {
      schema: {
        tags: ['cases'],
        summary: 'Caso activo de un chat',
        security: [{ InternalToken: [] }],
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          chat_id: z.string().min(1),
        }),
      },
    },
    async (request, reply) => {
      try {
        const view = await casesService.getActive(request.query.client_id, request.query.chat_id);
        return reply.send({ case: view });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );

  // PATCH /api/cases/:id → datos, tipo o cancelación. Una sola operación por llamada.
  r.patch(
    '/:id',
    {
      schema: {
        tags: ['cases'],
        summary: 'Actualiza datos, cambia el tipo o cancela un caso',
        security: [{ InternalToken: [] }],
        params: z.object({ id: z.coerce.number().int().positive() }),
        body: z
          .object({
            client_id: z.number().int().positive(),
            data: dataSchema.optional(),
            case_type: z.string().min(1).optional(),
            status: z.literal('cancelled').optional(),
            reason: z.string().max(500).optional(),
          })
          .refine((b) => [b.data, b.case_type, b.status].filter((v) => v !== undefined).length === 1, {
            message: 'Mandá exactamente uno de: data, case_type, status',
          }),
      },
    },
    async (request, reply) => {
      const { client_id, data, case_type, status, reason } = request.body;
      const caseId = request.params.id;
      try {
        const view = data
          ? await casesService.updateData({ clientId: client_id, caseId, data }, request.log)
          : case_type
            ? await casesService.changeType({ clientId: client_id, caseId, caseType: case_type }, request.log)
            : await casesService.cancel({ clientId: client_id, caseId, reason: status && reason }, request.log);
        return reply.send({ case: view });
      } catch (err) {
        return handleError(err, reply);
      }
    },
  );
}
