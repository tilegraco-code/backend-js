import { FastifyInstance } from 'fastify';
import { healthRoute } from './health.route';
import { exampleRoute } from './example.route';
import { webhookRoutes } from './webhooks';
import { messagesRoute } from './messages.route';
import { adminFollowUpRoute } from './admin/follow-up.route';
import { adminAccountLifecycleRoute } from './admin/account-lifecycle.route';
import { tiendanubeOauthRoutes } from './tiendanube-oauth.route';
import { tiendanubeRoutes } from './tiendanube.route';
import { googleOauthRoutes } from './google-oauth.route';
import { googleRoutes } from './google.route';
import { internalTokenAuth } from '../middlewares/auth.middleware';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(healthRoute);

  // Webhooks públicos (Unipile + Evolution), cada uno con su propio auth
  // (query token / connection_token / Bearer header). El dashboard registra las
  // URLs bajo /api/webhooks/..., y como es un plugin propio NO hereda el
  // internalTokenAuth del scope /api de más abajo (los hooks son encapsulados).
  await app.register(webhookRoutes, { prefix: '/api/webhooks' });

  // Compatibilidad: algunos webhooks de Unipile están configurados en su panel
  // con la URL sin el prefijo /api (p.ej. /webhooks/unipile/:clientId). Para no
  // perder eventos los aceptamos también bajo /webhooks. Mismo plugin, mismo auth.
  await app.register(webhookRoutes, { prefix: '/webhooks' });

  // OAuth de TiendaNube: público (lo pega el navegador / TiendaNube). La seguridad
  // la da el `state` firmado, no el internalTokenAuth. Por eso va fuera del scope /api.
  await app.register(tiendanubeOauthRoutes, { prefix: '/api/tiendanube' });

  // OAuth de Google: público (lo pega el navegador / Google). Misma lógica que
  // TiendaNube: la seguridad la da el `state` firmado, por eso va fuera del scope /api.
  await app.register(googleOauthRoutes, { prefix: '/api/google' });

  await app.register(
    async (api) => {
      api.addHook('onRequest', internalTokenAuth);
      await api.register(exampleRoute, { prefix: '/example' });
      await api.register(messagesRoute, { prefix: '/messages' });
      await api.register(adminFollowUpRoute, { prefix: '/admin' });
      await api.register(adminAccountLifecycleRoute, { prefix: '/admin' });
      await api.register(tiendanubeRoutes, { prefix: '/tiendanube' });
      await api.register(googleRoutes, { prefix: '/google' });
    },
    { prefix: '/api' },
  );
}
