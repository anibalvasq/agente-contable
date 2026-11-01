import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { crearAutenticadorDesdeEnv } from './auth/desdeEnv.js';
import { resolverConLlm } from './correos/procesar.js';
import { env } from './env.js';
import { registerMcp } from './mcp/server.js';
import { registerPanel } from './panel/routes.js';
import { createPanelStore } from './panel/store.js';

/**
 * El panel y el MCP SIN los canales de mensajería. Es lo que corre en Vercel
 * (api/index.ts): una función serverless no puede sostener Redis, la cola de
 * BullMQ ni un worker. Los canales (Telegram, WhatsApp) siguen en server.ts.
 */
export async function buildPanelApp(): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: true, bodyLimit: 262_144 });

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_IP,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
    errorResponseBuilder: () => ({ statusCode: 429, error: 'demasiadas solicitudes' }),
  });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  const store = await createPanelStore();
  const auth = await crearAutenticadorDesdeEnv();
  await registerMcp(app, { store, token: env.MCP_TOKEN });
  await registerPanel(app, { store, clave: env.PANEL_PASSWORD, produccion: env.NODE_ENV === 'production', resolverCorreo: resolverConLlm(), ...(auth ? { auth } : {}) });

  return app;
}
