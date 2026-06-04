import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signState, verifyState } from '../lib/oauth-state';
import { tiendanubeApiService } from '../services/tiendanube-api.service';
import { tiendanubeService } from '../services/tiendanube.service';

// Rutas OAuth de TiendaNube. PÚBLICAS: las pega el navegador / TiendaNube, sin
// internalTokenAuth. La seguridad la da el `state` firmado (HMAC con INTERNAL_API_KEY).
export async function tiendanubeOauthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  function dashboardUrl(status: 'connected' | 'error'): string {
    const base = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
    return `${base}/dashboard/integrations?tiendanube=${status}`;
  }

  // GET /api/tiendanube/oauth/connect?state=… → redirige al authorize de TiendaNube.
  // El dashboard ya firmó el state; lo re-firmamos no, sólo validamos que sea legítimo.
  r.get(
    '/oauth/connect',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Inicia el OAuth de TiendaNube (redirige al authorize)',
        querystring: z.object({ state: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const clientId = verifyState(request.query.state);
      if (!clientId) {
        return reply.redirect(dashboardUrl('error'));
      }

      const appId = process.env.TIENDANUBE_APP_ID;
      if (!appId) {
        request.log.error('TIENDANUBE_APP_ID no configurada');
        return reply.redirect(dashboardUrl('error'));
      }

      // Re-firmamos para refrescar el ts y acotar la ventana de validez en el callback.
      const state = signState(clientId);
      const authUrl = `https://www.tiendanube.com/apps/${appId}/authorize?state=${encodeURIComponent(state)}`;
      return reply.redirect(authUrl);
    },
  );

  // GET /api/tiendanube/oauth/callback?code=&state= → intercambia, guarda y vuelve al dashboard.
  r.get(
    '/oauth/callback',
    {
      schema: {
        tags: ['tiendanube'],
        summary: 'Callback del OAuth de TiendaNube',
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
        const token = await tiendanubeApiService.exchangeCode(code);

        // Datos de la tienda (best-effort: si falla, igual guardamos la conexión).
        let storeName: string | null = null;
        let storeUrl: string | null = null;
        try {
          const info = await tiendanubeService.fetchStoreInfo(token.user_id, token.access_token);
          storeName = info.name;
          storeUrl = info.url;
        } catch (e) {
          request.log.warn({ err: e }, 'No se pudo obtener info de la tienda TiendaNube');
        }

        await tiendanubeService.saveConnection({
          clientId,
          storeId: token.user_id,
          accessToken: token.access_token,
          tokenType: token.token_type,
          scope: token.scope ?? null,
          storeName,
          storeUrl,
        });

        return reply.redirect(dashboardUrl('connected'));
      } catch (e) {
        request.log.error({ err: e }, 'Falló el OAuth callback de TiendaNube');
        return reply.redirect(dashboardUrl('error'));
      }
    },
  );
}
