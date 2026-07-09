import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentSystemMessageService } from '../services/agent-system-message.service';
import { composioService } from '../services/composio.service';
import { refreshAgentRuntimeCache } from '../services/agent-runtime.service';
import { supabase } from '../lib/supabase';

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

  // GET /api/agents/:agentId/runtime-config → todo lo que el runtime LangGraph necesita en
  // una sola llamada: system message estático + client_id + allow-list de tools del agente.
  r.get(
    '/:agentId/runtime-config',
    {
      schema: {
        tags: ['agents'],
        summary: 'Config completa del agente para el runtime (system message + client_id + tools)',
        security: [{ InternalToken: [] }],
        params: z.object({ agentId: z.coerce.number().int().positive() }),
        response: {
          200: z.object({
            system_message: z.string(),
            client_id: z.number(),
            tools: z.record(z.string(), z.array(z.string())),
          }),
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const agentId = request.params.agentId;
        const [system_message, tools] = await Promise.all([
          agentSystemMessageService.build(agentId),
          composioService.getAgentMcpTools(agentId),
        ]);

        // client_id: agent → project → client_id.
        let client_id = 0;
        const { data: agent } = await supabase
          .from('agent')
          .select('project_id')
          .eq('agent_id', agentId)
          .maybeSingle();
        if (agent?.project_id != null) {
          const { data: project } = await supabase
            .from('project')
            .select('client_id')
            .eq('project_id', agent.project_id)
            .maybeSingle();
          client_id = project?.client_id ?? 0;
        }

        return { system_message, client_id, tools };
      } catch (e) {
        return reply.status(502).send({ error: (e as Error)?.message ?? 'Error desconocido' });
      }
    },
  );

  // POST /api/agents/:agentId/refresh-runtime → el dashboard avisa que cambió la config del
  // agente; el backend refresca el cache del runtime si es LangGraph (no-op si es n8n).
  r.post(
    '/:agentId/refresh-runtime',
    {
      schema: {
        tags: ['agents'],
        summary: 'Refresca el cache del runtime del agente al cambiar su config',
        security: [{ InternalToken: [] }],
        params: z.object({ agentId: z.coerce.number().int().positive() }),
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request, reply) => {
      await refreshAgentRuntimeCache(request.params.agentId, request.log);
      return reply.send({ ok: true });
    },
  );
}
