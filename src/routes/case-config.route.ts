import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { CASE_TEMPLATES } from '../schemas/case-templates';
import { caseConfigService } from '../services/case-config.service';

// Configuración de casos de un agente. La consume el tab "Casos" del dashboard, que verifica la
// sesión y que el agente sea del cliente antes de llamar acá.
export async function caseConfigRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /api/agents/:agentId/case-config
  r.get(
    '/:agentId/case-config',
    {
      schema: {
        tags: ['cases'],
        summary: 'Configuración de casos de un agente',
        security: [{ InternalToken: [] }],
        params: z.object({ agentId: z.coerce.number().int().positive() }),
      },
    },
    async (request, reply) => {
      try {
        return reply.send(await caseConfigService.get(request.params.agentId));
      } catch (err) {
        request.log.error({ err }, 'case-config: lectura falló');
        return reply.status(500).send({ error: 'No se pudo leer la configuración de casos' });
      }
    },
  );

  // PUT /api/agents/:agentId/case-config → guarda la configuración entera. 422 con `issues` si
  // no valida, para mostrar cada problema junto a su campo.
  r.put(
    '/:agentId/case-config',
    {
      schema: {
        tags: ['cases'],
        summary: 'Guarda la configuración de casos de un agente',
        security: [{ InternalToken: [] }],
        params: z.object({ agentId: z.coerce.number().int().positive() }),
        body: z.unknown(),
      },
    },
    async (request, reply) => {
      try {
        const result = await caseConfigService.save(request.params.agentId, request.body, request.log);
        if (!result.ok) {
          return reply.status(422).send({ error: result.issues[0]?.message ?? 'Configuración inválida', issues: result.issues });
        }
        return reply.send({ ok: true, config: result.config });
      } catch (err) {
        request.log.error({ err }, 'case-config: guardado falló');
        return reply.status(500).send({ error: 'No se pudo guardar la configuración de casos' });
      }
    },
  );

  // GET /api/agents/case-templates → plantillas por rubro para arrancar el editor.
  r.get(
    '/case-templates',
    {
      schema: { tags: ['cases'], summary: 'Plantillas de configuración de casos', security: [{ InternalToken: [] }] },
    },
    async () => ({ templates: CASE_TEMPLATES }),
  );
}
