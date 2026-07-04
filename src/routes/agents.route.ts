import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentSystemMessageService } from '../services/agent-system-message.service';

const errorResponseSchema = z.object({ error: z.string() });

export async function agentsRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/agents/:agentId/system-message → bloque ESTÁTICO del system message.
  // Lo consume n8n (Bearer interno). Cacheable: depende solo de agent_id.
  r.get(
    '/:agentId/system-message',
    {
      schema: {
        tags: ['agents'],
        summary: 'System message estático del agente (rol/tareas/tools/contexto/estilo/limites)',
        security: [{ InternalToken: [] }],
        params: z.object({ agentId: z.coerce.number().int().positive() }),
        response: {
          200: z.object({ system_message: z.string() }),
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const system_message = await agentSystemMessageService.build(request.params.agentId);
        return { system_message };
      } catch (e) {
        return reply.status(502).send({ error: (e as Error)?.message ?? 'Error desconocido' });
      }
    },
  );
}
