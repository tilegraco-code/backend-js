// Configuración del logger de Fastify (pino).
//
// Salidas:
//   - Consola: pino-pretty multilínea (LOG_PRETTY != 'false', cómodo en local) o JSON de
//     una línea (LOG_PRETTY=false, buscable en Easypanel).
//   - Better Stack: si BETTERSTACK_SOURCE_TOKEN está seteado, además de la consola.
//     BETTERSTACK_INGESTING_HOST es el host que muestra la source en Better Stack
//     (p.ej. s1234567.eu-nbg-2.betterstackdata.com); sin él se usa el default del SDK.
//
// Las URLs llevan secretos (el de ML en el path, el token de Unipile en la query): el
// serializer de `req` los enmascara ANTES de que el log salga a cualquier destino.
import type { FastifyServerOptions } from 'fastify';

/** Enmascara secretos conocidos en una URL de request. */
export function redactUrl(url: string): string {
  return (
    url
      // /api/webhooks/mercadolibre/<secret>
      .replace(/(\/webhooks\/mercadolibre\/)[^/?#]+/i, '$1***')
      // ?token=… / &connection_token=… / &key=…
      .replace(/([?&](?:token|connection_token|key|secret|api_key|access_token)=)[^&#]*/gi, '$1***')
  );
}

type TransportTarget = { target: string; level?: string; options?: Record<string, unknown> };

export function buildLoggerOptions(): FastifyServerOptions['logger'] {
  const level = process.env.LOG_LEVEL ?? 'info';
  const usePretty = process.env.LOG_PRETTY !== 'false';
  const betterstackToken = process.env.BETTERSTACK_SOURCE_TOKEN;
  const betterstackHost = process.env.BETTERSTACK_INGESTING_HOST;

  const targets: TransportTarget[] = [
    usePretty
      ? {
          target: 'pino-pretty',
          level,
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss Z',
            ignore: 'pid,hostname,service,env',
            singleLine: false,
          },
        }
      : // fd 1 = stdout, en JSON de una línea.
        { target: 'pino/file', level, options: { destination: 1 } },
  ];

  if (betterstackToken) {
    targets.push({
      // Ruta absoluta: con pnpm, el worker de pino no resuelve el paquete por nombre
      // desde su propio node_modules.
      target: require.resolve('@logtail/pino'),
      level,
      options: {
        sourceToken: betterstackToken,
        ...(betterstackHost
          ? { options: { endpoint: `https://${betterstackHost.replace(/^https?:\/\//, '')}` } }
          : {}),
      },
    });
  }

  return {
    level,
    transport: { targets },
    // Mismo shape que el serializer por defecto de Fastify, con la URL enmascarada.
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: redactUrl(request.url),
          hostname: request.hostname,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        };
      },
    },
    base: { service: 'backend-js', env: process.env.NODE_ENV ?? 'development' },
  };
}
