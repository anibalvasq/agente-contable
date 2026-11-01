import { env } from './env.js';
import { logger } from './logger.js';
import { buildPanelApp } from './vercel.js';

/**
 * El panel y el MCP en tu máquina, sin canales de mensajería: la misma app que
 * corre en Vercel (src/vercel.ts). Es lo que usas para trabajar el panel en local.
 */
const app = await buildPanelApp();
await app.listen({ host: '127.0.0.1', port: env.PORT });
logger.info(`panel → http://localhost:${env.PORT}/panel`);
