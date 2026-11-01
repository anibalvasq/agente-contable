import { env } from './env.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { createStore } from './memory/index.js';
import { getActiveAdapter } from './channels/registry.js';
import { buildServer } from './server.js';

async function main(): Promise<void> {
  loadConfig(); // valida agent.yaml al arrancar
  const store = await createStore();
  const adapter = await getActiveAdapter();
  const app = await buildServer(store, adapter);

  await app.listen({ host: '0.0.0.0', port: env.PORT });
  logger.info({ port: env.PORT, channel: adapter.name, store: env.STORE }, 'servidor arriba');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'apagando ordenadamente…');
    await app.close().catch(() => undefined);
    await store.close().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fallo al arrancar');
  process.exit(1);
});
