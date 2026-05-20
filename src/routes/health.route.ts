import { FastifyInstance } from 'fastify';
import { HealthResponse } from '../types';

export async function healthRoute(app: FastifyInstance): Promise<void> {
  app.get('/health', async (): Promise<HealthResponse> => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
}
