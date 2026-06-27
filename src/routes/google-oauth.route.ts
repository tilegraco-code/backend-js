import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signState, verifyState } from '../lib/oauth-state';
import { googleApiService } from '../services/google-api.service';
import { googleService } from '../services/google.service';

// Rutas OAuth de Google. PÚBLICAS: las pega el navegador / Google, sin
// internalTokenAuth. La seguridad la da el `state` firmado (HMAC con INTERNAL_API_KEY),
// igual que TiendaNube.
export async function googleOauthRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  function dashboardUrl(status: 'connected' | 'error'): string {
    const base = (process.env.DASHBOARD_URL ?? '').replace(/\/$/, '');
    return `${base}/dashboard/integrations?google=${status}`;
  }

  // GET /api/google/oauth/connect?state=… → redirige al consent de Google.
  r.get(
    '/oauth/connect',
    {
      schema: {
        tags: ['google'],
        summary: 'Inicia el OAuth de Google (redirige al consent screen)',
        querystring: z.object({ state: z.string().min(1) }),
      },
    },
    async (request, reply) => {
      const clientId = verifyState(request.query.state);
      if (!clientId) {
        return reply.redirect(dashboardUrl('error'));
      }

      try {
        // Re-firmamos para refrescar el ts y acotar la ventana de validez en el callback.
        const authUrl = googleApiService.authUrl(signState(clientId));
        return reply.redirect(authUrl);
      } catch (e) {
        request.log.error({ err: e }, 'No se pudo armar la URL de OAuth de Google');
        return reply.redirect(dashboardUrl('error'));
      }
    },
  );

  // GET /api/google/oauth/callback?code=&state= → intercambia, guarda y vuelve al dashboard.
  r.get(
    '/oauth/callback',
    {
      schema: {
        tags: ['google'],
        summary: 'Callback del OAuth de Google',
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
        const { tokens, email } = await googleApiService.exchangeCode(code);

        // Sin refresh_token no podemos refrescar después → conexión inútil.
        // Pasa si el usuario ya había consentido sin revocar; prompt=consent lo evita.
        if (!tokens.refresh_token) {
          request.log.error('Google OAuth no devolvió refresh_token');
          return reply.redirect(dashboardUrl('error'));
        }

        await googleService.saveConnection({
          clientId,
          googleEmail: email,
          accessToken: tokens.access_token ?? '',
          refreshToken: tokens.refresh_token,
          scope: tokens.scope ?? null,
          tokenType: tokens.token_type ?? null,
          expiryDate: tokens.expiry_date ?? null,
        });

        return reply.redirect(dashboardUrl('connected'));
      } catch (e) {
        request.log.error({ err: e }, 'Falló el OAuth callback de Google');
        return reply.redirect(dashboardUrl('error'));
      }
    },
  );
}
