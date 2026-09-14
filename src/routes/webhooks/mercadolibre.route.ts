import { timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mercadolibreWebhookService } from '../../services/mercadolibre-webhook.service';
import { mercadolibreQuestionsService } from '../../services/mercadolibre-questions.service';
import { dispatchToRuntime } from '../../services/agent-runtime.service';
import type { MercadolibreNotification } from '../../types/mercadolibre';

const okResponseSchema = z
  .object({ ok: z.boolean(), skipped: z.string().optional() })
  .passthrough();

const errorResponseSchema = z.object({ error: z.string() });

// ML manda campos distintos según el tópico — schema laxo, como el de Evolution.
const notificationSchema = z
  .object({
    resource: z.string(),
    // Coerce y no z.number(): si ML cambiara el tipo, un 400 acá haría que
    // reintente 5 veces y después descarte la notificación para siempre.
    user_id: z.coerce.number(),
    topic: z.string(),
    application_id: z.coerce.number().optional(),
    actions: z.array(z.string()).optional(),
  })
  .passthrough();

function secretMatches(received: string): boolean {
  const expected = process.env.MERCADOLIBRE_WEBHOOK_SECRET;
  if (!expected) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Callback de notificaciones de MercadoLibre.
 *
 * ML permite UNA sola URL por aplicación (no una por vendedor) y, a diferencia de
 * MercadoPago, NO firma las notificaciones: no hay header que verificar. Por eso
 * el secreto va en el path, igual que el connection_token de Unipile.
 *
 * El presupuesto de latencia es duro: si no devolvemos 200 en 500 ms, ML da de
 * baja el tópico y hay que volver a suscribirse a mano. Por eso el handler ACKea
 * ANTES de tocar la base — a diferencia del de Evolution, que puede darse el lujo
 * de hacer todo el trabajo de DB antes de responder.
 */
export async function mercadolibreWebhookRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/mercadolibre/:secret',
    {
      schema: {
        tags: ['mercadolibre-webhooks'],
        summary: 'Callback de notificaciones de MercadoLibre (orders_v2 + messages + questions)',
        params: z.object({ secret: z.string() }),
        body: notificationSchema,
        response: {
          200: okResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!secretMatches(request.params.secret)) {
        // 404 y no 401: no confirmamos que la ruta exista.
        return reply.status(404).send({ error: 'Not found' });
      }

      const payload = request.body as MercadolibreNotification;
      const appId = process.env.MERCADOLIBRE_APP_ID;
      if (appId && payload.application_id != null && String(payload.application_id) !== appId) {
        return reply.send({ ok: true, skipped: 'other_application' });
      }

      const topic = payload.topic;
      const log = request.log;

      // Una línea por notificación, ANTES de decidir qué hacer con ella. `received` es cuándo
      // ML registró el evento y `sent` cuándo salió este intento: la diferencia es la demora
      // de entrega, y `attempts > 1` delata que los intentos anteriores no nos llegaron.
      const receivedMs = typeof payload.received === 'string' ? Date.parse(payload.received) : NaN;
      log.info(
        {
          topic,
          resource: payload.resource,
          ml_user_id: payload.user_id,
          actions: payload.actions,
          attempts: payload.attempts,
          sent: payload.sent,
          received: payload.received,
          delay_s: Number.isFinite(receivedMs) ? Math.round((Date.now() - receivedMs) / 1000) : null,
        },
        'mercadolibre: notificación recibida',
      );

      if (topic === 'orders_v2') {
        setImmediate(() => {
          mercadolibreWebhookService.processOrder(payload, log).catch((err) => {
            log.error({ err, resource: payload.resource }, 'mercadolibre: processOrder falló');
          });
        });
        return reply.send({ ok: true });
      }

      if (topic === 'messages') {
        setImmediate(() => {
          mercadolibreWebhookService
            .processMessage(payload, log)
            .then((result) => {
              // Los descartes se loguean: este camino corre en background y su
              // resultado no vuelve por la respuesta HTTP, así que sin esto un
              // mensaje entrante se puede caer sin dejar rastro en ningún lado.
              if (!result.ok) {
                log.error({ resource: payload.resource, error: result.error },
                  'mercadolibre: mensaje entrante NO procesado');
                return;
              }
              if (result.skipped) {
                log.info({ resource: payload.resource, skipped: result.skipped },
                  'mercadolibre: mensaje entrante descartado');
                return;
              }
              if (!result.forward) return;
              const { workflowId, payload: forwardPayload } = result.forward;
              return dispatchToRuntime(forwardPayload, workflowId, 'mercadolibre', log);
            })
            .catch((err) => {
              log.error({ err, resource: payload.resource }, 'mercadolibre: processMessage falló');
            });
        });
        return reply.send({ ok: true });
      }

      if (topic === 'questions') {
        setImmediate(() => {
          mercadolibreQuestionsService
            .processQuestion(payload, log)
            .then((result) => {
              if (!result.ok) {
                log.error({ resource: payload.resource, error: result.error },
                  'mercadolibre: pregunta NO procesada');
              } else if (result.skipped) {
                log.info({ resource: payload.resource, skipped: result.skipped },
                  'mercadolibre: pregunta sin respuesta automática');
              }
            })
            .catch((err) => {
              log.error({ err, resource: payload.resource }, 'mercadolibre: processQuestion falló');
            });
        });
        return reply.send({ ok: true });
      }

      return reply.send({ ok: true, skipped: topic || 'unknown' });
    },
  );
}
