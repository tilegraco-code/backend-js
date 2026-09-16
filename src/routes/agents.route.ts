import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { agentSystemMessageService } from '../services/agent-system-message.service';
import { composioService } from '../services/composio.service';
import { refreshAgentRuntimeCache, dispatchToRuntime } from '../services/agent-runtime.service';
import { casesService } from '../services/cases.service';
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
  //
  // Sirve a las DOS topologías, y el runtime elige por `agent_type`:
  //   'react'  → el agente de siempre. La respuesta no cambia en nada.
  //   'router' → clasifica y deriva. Devuelve `routes` y NO devuelve tools: el router no
  //              ejecuta nada, ejecutan las ramas. Cada rama es un agente normal y el runtime
  //              trae su config pegándole a ESTE MISMO endpoint con el agent_id del hijo.
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
            project_id: z.number().nullable(),
            has_knowledge: z.boolean(),
            tools: z.record(z.string(), z.array(z.string())),
            // Tools de API propias (ej. TiendaNube) desde agent_tools (habilitadas).
            api_tools: z.array(
              z.object({
                name: z.string(),
                description: z.string().nullable(),
                type: z.string().nullable(),
                config: z.record(z.string(), z.unknown()).nullable(),
              }),
            ),
            agent_type: z.enum(['react', 'router']),
            // Ramas del router (vacío si agent_type === 'react').
            routes: z.array(
              z.object({
                agent_id: z.number(),
                nombre: z.string(),
                descripcion: z.string(),
                default: z.boolean(),
              }),
            ),
            // Tipos de caso activos. Vacío = el agente no trabaja con casos y el runtime no le
            // adjunta las tools de casos. Ver docs/documentos-y-casos-plan.md.
            case_types: z.array(z.object({ key: z.string(), label: z.string(), description: z.string() })),
          }),
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        const agentId = request.params.agentId;

        // El agente primero: `agent_type` decide qué prompt se arma y si hace falta pedirle
        // las tools a Composio (para un router es una llamada al pedo).
        const { data: agent } = await supabase
          .from('agent')
          .select('project_id, agent_type')
          .eq('agent_id', agentId)
          .maybeSingle();
        const agent_type = ((agent as { agent_type?: string } | null)?.agent_type ?? 'react') as
          | 'react'
          | 'router';
        const isRouter = agent_type === 'router';

        const [system_message, tools, apiToolsRes, routesRes, case_types] = await Promise.all([
          isRouter
            ? agentSystemMessageService.buildRouterInstructions(agentId)
            : agentSystemMessageService.build(agentId),
          isRouter
            ? Promise.resolve({} as Record<string, string[]>)
            : composioService.getAgentMcpTools(agentId),
          isRouter
            ? Promise.resolve({ data: [] as Record<string, unknown>[] })
            : supabase
                .from('agent_tools')
                .select('name, description, type, config')
                .eq('agent_id', agentId)
                .eq('enabled', true),
          isRouter
            ? supabase
                .from('agent_route')
                .select('child_agent_id, nombre, descripcion, is_default')
                .eq('parent_agent_id', agentId)
                .order('sort_order', { ascending: true })
            : Promise.resolve({ data: [] as Record<string, unknown>[] }),
          // Un router no abre casos: los abren sus ramas, cada una con su config.
          isRouter ? Promise.resolve([]) : casesService.listActiveTypes(agentId),
        ]);

        const api_tools = (apiToolsRes.data ?? []).map((t) => ({
          name: t.name as string,
          description: (t.description as string | null) ?? null,
          type: (t.type as string | null) ?? null,
          config: (t.config as Record<string, unknown> | null) ?? null,
        }));

        // `is_default` se renombra a `default` porque es el nombre que espera el runtime.
        const routes = (routesRes.data ?? []).map((r) => ({
          agent_id: r.child_agent_id as number,
          nombre: r.nombre as string,
          descripcion: (r.descripcion as string | null) ?? '',
          default: Boolean(r.is_default),
        }));

        // client_id: agent → project → client_id. De paso resolvemos el project_id (scope del
        // RAG) y si el proyecto tiene documentos listos (has_knowledge) para que el runtime
        // decida si adjunta el tool de búsqueda en la base de conocimiento. Un router no hace
        // RAG (no responde), así que ahí ni preguntamos.
        let client_id = 0;
        let project_id: number | null = null;
        let has_knowledge = false;
        if (agent?.project_id != null) {
          project_id = agent.project_id;
          const [{ data: project }, docs] = await Promise.all([
            supabase
              .from('project')
              .select('client_id')
              .eq('project_id', agent.project_id)
              .maybeSingle(),
            isRouter
              ? Promise.resolve({ count: 0 })
              : supabase
                  .from('documents')
                  .select('id', { count: 'exact', head: true })
                  .eq('project_id', agent.project_id)
                  .eq('status', 'ready'),
          ]);
          client_id = project?.client_id ?? 0;
          has_knowledge = (docs.count ?? 0) > 0;
        }

        return {
          system_message,
          client_id,
          project_id,
          has_knowledge,
          tools,
          api_tools,
          agent_type,
          routes,
          case_types,
        };
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

  // POST /api/agents/run-turn → dispara un turno del agente para un workflow/chat.
  //
  // Es la puerta de entrada de los canales que NO tienen webhook de proveedor: el "test agent"
  // del dashboard y el snippet web. En vez de postear al webhook de n8n (que no existe para
  // agentes LangGraph), delegan acá y el backend rutea por runtime igual que un webhook real.
  // La respuesta la persiste `runViaAgent` vía sendOutgoing, que para los providers WEB y TEST
  // sólo persiste → el UI del test la lee por Realtime y el widget por su polling.
  // Fire & forget: no bloqueamos el turno completo.
  r.post(
    '/run-turn',
    {
      schema: {
        tags: ['agents'],
        summary: 'Dispara un turno del agente para un workflow/chat (test del dashboard, snippet web)',
        security: [{ InternalToken: [] }],
        body: z.object({
          workflow_id: z.coerce.number().int().positive(),
          chat_id: z.string().min(1),
          // Puede venir vacío si el mensaje es sólo un adjunto (una foto sin texto).
          message: z.string(),
          nombre: z.string().optional(),
          // De dónde viene el turno. Queda en agentuse.channel, así que 'test' por default
          // evita que un turno de prueba se cuente como tráfico real.
          channel: z.string().min(1).optional(),
          // Adjuntos ya en Storage y firmados por quien llama. Ver attachment-ingest.service.
          attachments: z
            .array(
              z.object({
                kind: z.enum(['image', 'document', 'audio', 'video', 'other']),
                mime: z.string(),
                name: z.string().nullable(),
                url: z.string(),
              }),
            )
            .optional(),
        }),
        response: { 200: z.object({ ok: z.boolean() }), 400: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { workflow_id, chat_id, message, nombre, channel, attachments } = request.body;
      if (!message && !attachments?.length) {
        return reply.status(400).send({ error: 'Se necesita message o attachments' });
      }
      void dispatchToRuntime(
        { chat_id, question: message, nombre: nombre ?? 'Test', attachments },
        workflow_id,
        channel ?? 'test',
        request.log,
      ).catch((e) => request.log.error({ err: e, workflow_id }, 'run-turn: dispatch falló'));
      return reply.send({ ok: true });
    },
  );
}
