import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sendCapiEvent } from '../services/meta-capi.service';
import { internalTokenAuth } from '../middlewares/auth.middleware';

/**
 * Eventos que puede disparar el NAVEGADOR (endpoint público). Whitelist: mapea el
 * nombre del dataLayer al event_name que espera Meta. Todo lo que no esté acá se rechaza.
 */
const BROWSER_EVENTS: Record<string, string> = {
  lead_trigger: 'Lead',
  registration_trigger: 'CompleteRegistration',
  start_trial_trigger: 'StartTrial',
  agent_drafted_trigger: 'Agent_Drafted',
};

const browserBodySchema = z.object({
  event: z.string(),
  event_id: z.string().uuid(),
  event_source_url: z.string().url().optional(),
  email: z.string().email().optional(),
  external_id: z.union([z.string(), z.number()]).optional(),
  fbp: z.string().optional(),
  fbc: z.string().optional(),
  custom_data: z.record(z.unknown()).optional(),
});

/**
 * Eventos server-to-server (los manda otro backend nuestro, p.ej. el webhook de
 * MercadoPago del dashboard). Van con event_name de Meta directo, no por whitelist.
 */
const serverBodySchema = z.object({
  event_name: z.string().min(1),
  // Server-side no deduplica con el pixel del navegador, así que aceptamos cualquier
  // string (p.ej. `subscribe:<preapproval_id>` para idempotencia entre reintentos).
  event_id: z.string().min(1),
  event_source_url: z.string().url().optional(),
  action_source: z.enum(['website', 'app', 'system_generated']).default('website'),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  external_id: z.union([z.string(), z.number()]).optional(),
  fbp: z.string().optional(),
  fbc: z.string().optional(),
  custom_data: z.record(z.unknown()).optional(),
});

export async function metaCapiRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // POST /api/tracking/track — PÚBLICO, lo pega el navegador. Whitelist de eventos.
  r.post(
    '/track',
    {
      schema: {
        tags: ['tracking'],
        summary: 'Recibe un evento del navegador y lo reenvía a Meta CAPI',
        body: browserBodySchema,
        response: { 200: z.object({ ok: z.boolean() }), 400: z.object({ error: z.string() }) },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const eventName = BROWSER_EVENTS[b.event];
      if (!eventName) {
        return reply.status(400).send({ error: 'evento no permitido' });
      }

      // Fire & forget: el tracking nunca debe frenar la UX del navegador.
      void sendCapiEvent(
        {
          eventName,
          eventId: b.event_id,
          eventSourceUrl: b.event_source_url,
          actionSource: 'website',
          customData: b.custom_data,
          user: {
            email: b.email,
            externalId: b.external_id,
            fbp: b.fbp,
            fbc: b.fbc,
            clientIpAddress: request.ip, // trustProxy activo en server.ts
            clientUserAgent: request.headers['user-agent'],
          },
        },
        request.log,
      ).catch((err) => request.log.error({ err }, 'track: sendCapiEvent falló'));

      return reply.status(200).send({ ok: true });
    },
  );

  // POST /api/tracking/server-event — INTERNO (x-internal-token). Server-to-server:
  // lo usa el webhook de MercadoPago del dashboard para Subscribe / InitiateCheckout.
  r.post(
    '/server-event',
    {
      onRequest: internalTokenAuth,
      schema: {
        tags: ['tracking'],
        summary: 'Recibe un evento server-side (Subscribe, etc.) y lo reenvía a Meta CAPI',
        security: [{ InternalToken: [] }],
        body: serverBodySchema,
        response: { 200: z.object({ ok: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const b = request.body;
      const ok = await sendCapiEvent(
        {
          eventName: b.event_name,
          eventId: b.event_id,
          eventSourceUrl: b.event_source_url,
          actionSource: b.action_source,
          customData: b.custom_data,
          user: {
            email: b.email,
            phone: b.phone,
            externalId: b.external_id,
            fbp: b.fbp,
            fbc: b.fbc,
          },
        },
        request.log,
      );
      return reply.status(200).send({ ok });
    },
  );
}
