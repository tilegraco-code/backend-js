import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { unipileWebhookAuth } from '../../middlewares/unipile-webhook-auth.middleware';
import { unipileWebhookService } from '../../services/unipile-webhook.service';
import { dispatchToRuntime } from '../../services/agent-runtime.service';

const okResponseSchema = z
  .object({
    ok: z.boolean(),
    skipped: z.string().optional(),
    message: z.string().optional(),
    account_status: z.string().optional(),
  })
  .passthrough();

const errorResponseSchema = z.object({
  error: z.string(),
});

const senderSchema = z.object({
  attendee_id: z.string(),
  attendee_name: z.string(),
  attendee_provider_id: z.string(),
  attendee_profile_url: z.string().nullable(),
});

const messageWebhookSchema = z
  .object({
    event: z.string(),
    account_id: z.string(),
    account_type: z.string(),
    account_info: z
      .object({
        user_id: z.string().nullish(),
        feature: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    chat_id: z.string(),
    message_id: z.string(),
    message: z.string(),
    timestamp: z.string(),
    webhook_name: z.string().optional(),
    is_sender: z.boolean().optional(),
    sender: senderSchema,
    attendees: z.array(senderSchema).optional(),
    attachments: z
      .array(
        z.object({
          type: z.string(),
          mimetype: z.string(),
          url: z.string(),
        }),
      )
      .optional(),
  })
  .passthrough();

const accountStatusWebhookSchema = z.object({
  AccountStatus: z.object({
    account_id: z.string(),
    message: z.string(),
    account_type: z.string().optional(),
    error: z.string().optional(),
  }),
});

const accountConnectedBodySchema = z
  .object({
    account_id: z.string().optional(),
    account_type: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const tokenQuerySchema = z.object({
  token: z.string().optional(),
});

export async function unipileWebhookRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/webhooks/unipile/accounts — status de cuenta
  r.post(
    '/unipile/accounts',
    {
      preHandler: unipileWebhookAuth,
      schema: {
        tags: ['unipile-webhooks'],
        summary: 'Webhook de status de cuenta de Unipile',
        querystring: tokenQuerySchema,
        body: accountStatusWebhookSchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await unipileWebhookService.processAccountStatus(request.body, request.log);
      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }
      return reply.send(result);
    },
  );

  // POST /api/webhooks/unipile/:clientId/account-connected — callback de hosted auth
  // Auth propio (connection_token contra DB), no usa unipileWebhookAuth
  r.post(
    '/unipile/:clientId/account-connected',
    {
      schema: {
        tags: ['unipile-webhooks'],
        summary: 'Callback post-hosted-auth (empareja inbox pending con account_id)',
        params: z.object({ clientId: z.string() }),
        querystring: tokenQuerySchema,
        body: accountConnectedBodySchema,
        response: {
          200: okResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const clientId = Number.parseInt(request.params.clientId, 10);
      if (!Number.isFinite(clientId) || clientId <= 0) {
        return reply.status(400).send({ error: 'Invalid client' });
      }

      const token = request.query.token ?? '';
      const result = await unipileWebhookService.processAccountConnected(
        clientId,
        token,
        request.body,
        request.log,
      );

      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }
      return reply.send(result);
    },
  );

  // POST /api/webhooks/unipile/:clientId — webhook principal (message_received)
  r.post(
    '/unipile/:clientId',
    {
      preHandler: unipileWebhookAuth,
      schema: {
        tags: ['unipile-webhooks'],
        summary: 'Webhook principal de Unipile (mensajes entrantes)',
        params: z.object({ clientId: z.string() }),
        querystring: tokenQuerySchema,
        body: messageWebhookSchema,
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
      const result = await unipileWebhookService.processMessage(request.body, request.log);

      if (!result.ok) {
        return reply.status(result.status).send({ error: result.error });
      }

      // Responder a Unipile inmediatamente; el forward a n8n va en background
      // para no bloquear el ACK del webhook.
      if (result.forward) {
        const { workflowId, payload } = result.forward;
        const log = request.log;
        setImmediate(() => {
          dispatchToRuntime(payload, workflowId, 'whatsapp', log).catch(() => {
            /* errores ya logueados dentro */
          });
        });
      }

      return reply.send({ ok: true, ...(result.skipped ? { skipped: result.skipped } : {}) });
    },
  );
}
