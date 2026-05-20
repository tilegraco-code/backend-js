import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { exampleService } from '../services/example.service';

const createExampleSchema = z.object({
  name: z.string().min(1).max(255),
});

export async function exampleRoute(app: FastifyInstance): Promise<void> {
  app.get('/', async () => {
    const items = await exampleService.list();
    return { items };
  });

  app.post('/', async (request, reply) => {
    const parsed = createExampleSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'ValidationError',
        issues: parsed.error.flatten(),
      });
    }

    const item = await exampleService.create(parsed.data);
    return reply.status(201).send({ item });
  });
}
