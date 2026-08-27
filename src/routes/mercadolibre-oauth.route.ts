import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signState, verifyState } from '../lib/oauth-state';
import { mercadolibreApiService } from '../services/mercadolibre-api.service';
import { mercadolibreService } from '../services/mercadolibre.service';

// Rutas OAuth de MercadoLibre. PÚBLICAS: las pega el navegador / ML, sin
// internalTokenAuth. La seguridad la da el `state` firmado (HMAC con INTERNAL_API_KEY),
// igual que en TiendaNube y Google.
export async function mercadolibreOauthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  function dashboardUrl(status: 'connected' | 'error'): string {
    const base = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
    // Canales y no Integraciones: MercadoLibre crea una fila en unipile_inboxes,
    // así que consume cupo de canal y se administra junto al resto de los canales.
    return `${base}/dashboard/connect?mercadolibre=${status}`;
  }

  // GET /api/mercadolibre/oauth/connect?state=… → redirige al authorize de ML.
  r.get(
    '/oauth/connect',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Inicia el OAuth de MercadoLibre (redirige al authorize)',
        querystring: z.object({ state: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const clientId = verifyState(request.query.state);
      if (!clientId) {
        return reply.redirect(dashboardUrl('error'));
      }

      const appId = process.env.MERCADOLIBRE_APP_ID;
      const redirectUri = process.env.MERCADOLIBRE_REDIRECT_URI;
      if (!appId || !redirectUri) {
        request.log.error('MERCADOLIBRE_APP_ID y/o MERCADOLIBRE_REDIRECT_URI no configuradas');
        return reply.redirect(dashboardUrl('error'));
      }

      // El authorize vive en el dominio del país del vendedor (.com.ar para MLA,
      // .com.br para MLB…). El token endpoint, en cambio, es único para todos.
      const authDomain = (
        process.env.MERCADOLIBRE_AUTH_DOMAIN ?? 'https://auth.mercadolibre.com.ar'
      ).replace(/\/$/, '');

      // Re-firmamos para refrescar el ts y acotar la ventana de validez en el callback.
      const state = signState(clientId);
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: appId,
        redirect_uri: redirectUri,
        state,
      });

      return reply.redirect(`${authDomain}/authorization?${params.toString()}`);
    },
  );

  // GET /api/mercadolibre/oauth/callback?code=&state= → intercambia, guarda y vuelve al dashboard.
  //
  // El redirect_uri NO puede llevar información variable (lo exige ML), así que el
  // client_id viaja en el `state` firmado — mismo truco que en TiendaNube.
  r.get(
    '/oauth/callback',
    {
      schema: {
        tags: ['mercadolibre'],
        summary: 'Callback del OAuth de MercadoLibre',
        querystring: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      if (error || !code || !state) {
        return reply.redirect(dashboardUrl('error'));
      }

      const clientId = verifyState(state);
      if (!clientId) {
        return reply.redirect(dashboardUrl('error'));
      }

      try {
        const token = await mercadolibreApiService.exchangeCode(code);

        // Nickname y site (best-effort: si falla, igual guardamos la conexión).
        let nickname: string | null = null;
        let siteId = 'MLA';
        try {
          const me = await mercadolibreApiService.fetchMe(token.access_token);
          nickname = me.nickname ?? null;
          siteId = me.site_id ?? siteId;
        } catch (e) {
          request.log.warn({ err: e }, 'No se pudo obtener el usuario de MercadoLibre');
        }

        await mercadolibreService.saveConnection({
          clientId,
          mlUserId: token.user_id,
          siteId,
          nickname,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresIn: token.expires_in,
          scope: token.scope ?? null,
        });

        await mercadolibreService.upsertInbox({
          clientId,
          mlUserId: token.user_id,
          displayName: nickname ?? `MercadoLibre ${token.user_id}`,
        });

        return reply.redirect(dashboardUrl('connected'));
      } catch (e) {
        request.log.error({ err: e }, 'Falló el OAuth callback de MercadoLibre');
        return reply.redirect(dashboardUrl('error'));
      }
    },
  );
}
