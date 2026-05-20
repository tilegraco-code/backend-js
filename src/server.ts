import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { registerRoutes } from './routes';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport:
        process.env.NODE_ENV === 'production'
          ? undefined
          : {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'HH:MM:ss Z' },
            },
    },
    trustProxy: true,
  });

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: true,
    credentials: true,
  });

  await registerRoutes(app);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const statusCode = error.statusCode ?? 500;
    reply.status(statusCode).send({
      error: error.name ?? 'InternalServerError',
      message: error.message,
      statusCode,
    });
  });

  return app;
}
