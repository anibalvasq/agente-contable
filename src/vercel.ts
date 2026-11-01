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

  const store = await createPanelStore();
  const auth = await crearAutenticadorDesdeEnv();

  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_IP,
    timeWindow: '1 minute',
    // /health consulta la base: sí cuenta para el límite por IP (no es un endpoint gratis).
    errorResponseBuilder: () => ({ statusCode: 429, error: 'demasiadas solicitudes' }),
  });


  // /health prueba de verdad la base (y la tabla equipo, que es la que decide quién entra): así un
  // DATABASE_URL mal puesto se ve aquí y no como un "no se pudo conectar" en la pantalla de ingreso.
  app.get('/health', async (_req, reply) => {
    const checks: Record<string, string> = { store: env.STORE };
    let ok = true;
    if (env.STORE === 'postgres') {
      try {
        const { query } = await import('./db/client.js');
        const r = await query<{ n: string }>('SELECT count(*)::text AS n FROM equipo');
        checks.postgres = 'ok';
        checks.equipo_miembros = r.rows[0]?.n ?? '?';
      } catch (err) {
        ok = false;
        // El mensaje del driver (p. ej. "password authentication failed") solo fuera de producción.
        checks.postgres = process.env.VERCEL_ENV === 'production' ? 'error' : err instanceof Error ? err.message : 'error';
      }
    }
    checks.supabase_auth = auth ? 'configurado' : 'sin configurar';
    return reply.code(ok ? 200 : 503).send({ ok, checks, ts: new Date().toISOString() });
  });

  await registerMcp(app, { store, token: env.MCP_TOKEN });
  await registerPanel(app, { store, clave: env.PANEL_PASSWORD, produccion: env.NODE_ENV === 'production', resolverCorreo: resolverConLlm(), ...(auth ? { auth } : {}) });

  return app;
}
