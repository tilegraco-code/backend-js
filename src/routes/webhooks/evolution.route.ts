import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { evolutionWebhookAuth } from '../../middlewares/evolution-webhook-auth.middleware';
import { evolutionWebhookService } from '../../services/evolution-webhook.service';
import { dispatchToRuntime } from '../../services/agent-runtime.service';

const okResponseSchema = z
  .object({
    ok: z.boolean(),
    skipped: z.string().optional(),
    account_status: z.string().optional(),
  })
  .passthrough();

const errorResponseSchema = z.object({
  error: z.string(),
});

// Los payloads de Evolution varían mucho según el evento — schema laxo.
const evolutionWebhookSchema = z
  .object({
    event: z.string().optional(),
    instance: z.string().optional(),
    data: z.unknown().optional(),
  })
  .passthrough();

export async function evolutionWebhookRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/webhooks/evolution/:clientId — webhook principal de EvolutionAPI.
  // clientId es informativo: la resolución real del inbox se hace por payload.instance.
  r.post(
    '/evolution/:clientId',
    {
      preHandler: evolutionWebhookAuth,
      schema: {
        tags: ['evolution-webhooks'],
        summary: 'Webhook de EvolutionAPI (mensajes y estado de conexión)',
        params: z.object({ clientId: z.string() }),
        body: evolutionWebhookSchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const payload = request.body;
      const event = (payload.event ?? '').toLowerCase();

      if (event === 'connection.update') {
        const result = await evolutionWebhookService.processConnectionUpdate(payload, request.log);
        if (!result.ok) {
          return reply.status(result.status).send({ error: result.error });
        }
        return reply.send(result);
      }

      if (event === 'messages.upsert' || event === 'send.message') {
        const result = await evolutionWebhookService.processMessage(payload, request.log);

        if (!result.ok) {
          return reply.status(result.status).send({ error: result.error });
        }

        // ACK inmediato; la ejecución del agente (n8n o LangGraph) va en background.
        if (result.forward) {
          const { workflowId, payload: n8nPayload } = result.forward;
          const log = request.log;
          setImmediate(() => {
            dispatchToRuntime(n8nPayload, workflowId, 'whatsapp', log).catch(() => {
              /* errores ya logueados dentro */
            });
          });
        }

        return reply.send({ ok: true, ...(result.skipped ? { skipped: result.skipped } : {}) });
      }

      // messages.update y otros eventos: ignorar.
      return reply.send({ ok: true, skipped: event || 'unknown' });
    },
  );
}
