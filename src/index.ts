import 'dotenv/config';
import { buildServer } from './server';
import { startJobs, stopJobs } from './jobs';

async function main(): Promise<void> {
  const app = await buildServer();
  const port = Number(process.env.PORT ?? 3000);
  const host = '0.0.0.0';

  try {
    await app.listen({ port, host });
    app.log.info(`Servidor escuchando en http://${host}:${port}`);

    startJobs(app.log);
  } catch (err) {
    app.log.error(err, 'Error arrancando el servidor');
    process.exit(1);
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`Recibida señal ${signal}, cerrando...`);
    try {
      stopJobs();
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error durante shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fallo fatal al iniciar:', err);
  process.exit(1);
});
