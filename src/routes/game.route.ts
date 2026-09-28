import { FastifyInstance } from 'fastify';
import { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { gameStore } from '../game/game.store';

/**
 * Rutas públicas del juego del stand. Van fuera del scope /api porque las abre el
 * teléfono del jugador.
 */
export async function gameRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // GET /g/ig/:sessionId — link a Instagram del final de la partida. No hay forma de saber
  // si alguien nos sigue, pero sí quién tocó el link.
  r.get(
    '/ig/:sessionId',
    {
      schema: {
        tags: ['game'],
        summary: 'Redirige a Instagram y registra el click del jugador',
        params: z.object({ sessionId: z.string() }),
      },
    },
    async (request, reply) => {
      const target = process.env.GAME_INSTAGRAM_URL;
      if (!target) return reply.status(404).send({ error: 'Not found' });

      const { sessionId } = request.params;
      if (z.string().uuid().safeParse(sessionId).success) {
        await gameStore.markIgClick(sessionId).catch((err) => {
          request.log.error({ err, sessionId }, 'juego: no se pudo registrar el click a Instagram');
        });
      }
      return reply.redirect(target);
    },
  );
}
