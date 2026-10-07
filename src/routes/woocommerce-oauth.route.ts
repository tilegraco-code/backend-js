import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { verifyStateData } from '../lib/oauth-state';
import { AUTHORIZE_STATE_MAX_AGE_MS, woocommerceService } from '../services/woocommerce.service';

// Callback del flujo de autorización de WooCommerce (/wc-auth/v1/authorize). PÚBLICO:
// lo llama el WordPress de la tienda (server-to-server) apenas el dueño aprueba, con
// las claves en el body. La seguridad la da el `user_id`, que es nuestro state firmado
// (client_id + URL de la tienda): sin él no se guarda nada.
//
// Si respondemos error, WooCommerce le muestra un error al usuario y no lo devuelve
// al dashboard; si respondemos 200, lo redirige al return_url con success=1.
export async function woocommerceOauthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/oauth/callback',
    {
      schema: {
        tags: ['woocommerce'],
        summary: 'Callback del flujo de autorización de WooCommerce (recibe las claves)',
        body: z.object({
          key_id: z.coerce.number().optional(),
          user_id: z.string().min(1),
          consumer_key: z.string().min(10),
          consumer_secret: z.string().min(10),
          key_permissions: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const state = verifyStateData(request.body.user_id, AUTHORIZE_STATE_MAX_AGE_MS);
      const storeUrl = typeof state?.store_url === 'string' ? state.store_url : null;
      if (!state || !storeUrl) {
        return reply.status(400).send({ error: 'state inválido o vencido' });
      }

      try {
        await woocommerceService.saveFromAuthorize({
          clientId: state.client_id,
          storeUrl,
          consumerKey: request.body.consumer_key,
          consumerSecret: request.body.consumer_secret,
          keyPermissions: request.body.key_permissions ?? null,
        });
      } catch (e) {
        request.log.error({ err: e, clientId: state.client_id }, 'woocommerce callback: no se pudo guardar la conexión');
        return reply.status(500).send({ error: 'No se pudo guardar la conexión' });
      }

      // Validación contra la tienda fuera de este request (ver saveFromAuthorize). Un
      // pequeño delay deja que WordPress termine de responder y libere el worker.
      setTimeout(() => {
        woocommerceService.refreshConnectionInfo(state.client_id).catch((err) => {
          request.log.error({ err, clientId: state.client_id }, 'woocommerce callback: validación posterior falló');
        });
      }, 3_000);

      return { ok: true };
    },
  );
}
