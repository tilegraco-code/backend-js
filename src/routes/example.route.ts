import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { exampleService } from '../services/example.service';

const exampleItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string().optional(),
});

const createExampleBodySchema = z.object({
  name: z.string().min(1).max(255),
});

const listResponseSchema = z.object({
  items: z.array(exampleItemSchema),
});

const createResponseSchema = z.object({
  item: exampleItemSchema,
});

export async function exampleRoute(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/',
    {
      schema: {
        tags: ['example'],
        summary: 'Listar items',
        security: [{ InternalToken: [] }],
        response: { 200: listResponseSchema },
      },
    },
    async () => {
      const items = await exampleService.list();
      return { items };
    },
  );

  r.post(
    '/',
    {
      schema: {
        tags: ['example'],
        summary: 'Crear item',
        security: [{ InternalToken: [] }],
        body: createExampleBodySchema,
        response: {
          201: createResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const item = await exampleService.create(request.body);
      return reply.status(201).send({ item });
    },
  );
}
