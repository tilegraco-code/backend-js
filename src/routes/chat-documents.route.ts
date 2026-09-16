import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { casesService } from '../services/cases.service';
import { chatDocumentsService, MAX_ATTEMPTS } from '../services/chat-documents.service';

const errorResponseSchema = z.object({ error: z.string() });

const documentSchema = z.object({
  id: z.number(),
  message_id: z.string(),
  received_at: z.string(),
  kind: z.string(),
  mime: z.string(),
  name: z.string().nullable(),
  status: z.string(),
  doc_type: z.string().nullable(),
  summary: z.string().nullable(),
  legible: z.boolean().nullable(),
  issues: z.array(z.string()),
  duplicate_of: z.number().nullable(),
  case_id: z.number().nullable(),
  drive_url: z.string().nullable(),
});

export async function chatDocumentsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/chats/:chatId/documents?client_id= → lo que mandó el cliente en este chat.
  //
  // Lo consume la tool `documentos_del_chat` de agente-tilegra. El client_id sale de la
  // config del agente, no del modelo, y scopea la consulta: un chat_id de otro cliente
  // devuelve vacío. No se exponen el path de Storage ni los campos internos de la cola.
  r.get(
    '/:chatId/documents',
    {
      schema: {
        tags: ['chat-documents'],
        summary: 'Documentos recibidos en un chat, con su clasificación y estado',
        security: [{ InternalToken: [] }],
        params: z.object({ chatId: z.string().min(1) }),
        querystring: z.object({
          client_id: z.coerce.number().int().positive(),
          // `active_case`: si el chat tiene un caso activo, solo sus documentos. Lo usa la tool del
          // agente: los archivos de un caso cancelado o de antes del caso no cuentan, y si los ve
          // le dice al cliente que "ya los mandó". Sin el parámetro, todos (panel de la bandeja).
          scope: z.enum(['all', 'active_case']).default('all'),
        }),
        response: {
          200: z.object({
            documents: z.array(documentSchema),
            // Documentos del chat que quedaron fuera por el scope.
            excluded_count: z.number(),
            case_number: z.string().nullable(),
          }),
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const { client_id, scope } = request.query;
        const [all, activeCase] = await Promise.all([
          chatDocumentsService.listForChat(client_id, request.params.chatId),
          scope === 'active_case' ? casesService.getActiveRow(client_id, request.params.chatId) : null,
        ]);
        const rows = activeCase ? all.filter((row) => row.case_id === activeCase.id) : all;
        return {
          excluded_count: all.length - rows.length,
          case_number: activeCase?.number ?? null,
          documents: rows.map((row) => ({
            id: row.id,
            message_id: row.message_id,
            received_at: row.created_at,
            kind: row.kind,
            mime: row.mime,
            name: row.name,
            // Un failed que todavía tiene reintentos no es definitivo: para quien consulta
            // sigue en revisión. Si no, el agente le pediría al cliente que reenvíe algo que
            // en un minuto se procesa solo.
            status: row.status === 'failed' && row.attempts < MAX_ATTEMPTS ? 'processing' : row.status,
            doc_type: row.doc_type,
            summary: row.summary,
            legible: row.legible,
            issues: row.issues ?? [],
            duplicate_of: row.duplicate_of,
            case_id: row.case_id,
            drive_url: row.external_ref?.drive_url ?? null,
          })),
        };
      } catch (err) {
        request.log.error({ err }, 'chat-documents: listado falló');
        return reply.status(500).send({ error: 'No se pudieron listar los documentos' });
      }
    },
  );
}
