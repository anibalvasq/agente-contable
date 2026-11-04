import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { crearAutenticadorDesdeEnv } from './auth/desdeEnv.js';
import { resolverConLlm } from './correos/procesar.js';
import { env } from './env.js';
import { registerMcp } from './mcp/server.js';
import { crearClaveIaDesdeEnv } from './panel/claveIaDesdeEnv.js';
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
        // La categoría (y qué arreglar) se muestra siempre: no revela host, usuario ni contraseña.
        // El mensaje crudo del driver, solo fuera de producción.
        const { motivoErrorDb } = await import('./db/diagnostico.js');
        const d = motivoErrorDb(err);
        checks.postgres = 'error';
        checks.motivo = d.motivo;
        checks.ayuda = d.ayuda;
        if (process.env.VERCEL_ENV !== 'production') checks.detalle = err instanceof Error ? err.message : String(err);
      }
    }
    checks.supabase_auth = auth ? 'configurado' : 'sin configurar';
    // A dónde llevan los enlaces de los correos de invitación. Si sale «sin definir», Supabase usa su
    // Site URL (típicamente localhost). La URL del propio panel no es un dato secreto.
    checks.panel_url = env.PANEL_URL ?? 'sin definir (los enlaces del correo irán al Site URL de Supabase)';
    return reply.code(ok ? 200 : 503).send({ ok, checks, ts: new Date().toISOString() });
  });

  await registerMcp(app, { store, token: env.MCP_TOKEN });
  const claveIa = await crearClaveIaDesdeEnv(Boolean(auth));
  await registerPanel(app, {
    store,
    clave: env.PANEL_PASSWORD,
    produccion: env.NODE_ENV === 'production',
    resolverCorreo: resolverConLlm(),
    ...(auth ? { auth } : {}),
    ...(claveIa ? { claveIa } : {}),
  });

  return app;
}
