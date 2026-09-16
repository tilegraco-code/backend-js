import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
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
  extracted: z.record(z.unknown()).nullable(),
  legible: z.boolean().nullable(),
  issues: z.array(z.string()),
  duplicate_of: z.number().nullable(),
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
        querystring: z.object({ client_id: z.coerce.number().int().positive() }),
        response: {
          200: z.object({ documents: z.array(documentSchema) }),
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const rows = await chatDocumentsService.listForChat(
          request.query.client_id,
          request.params.chatId,
        );
        return {
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
            extracted: row.extracted,
            legible: row.legible,
            issues: row.issues ?? [],
            duplicate_of: row.duplicate_of,
          })),
        };
      } catch (err) {
        request.log.error({ err }, 'chat-documents: listado falló');
        return reply.status(500).send({ error: 'No se pudieron listar los documentos' });
      }
    },
  );
}
