import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from 'fastify';
import { env } from './env.js';
import { logger } from './logger.js';
import { loadConfig } from './config.js';
import { makeChannelContext } from './channels/ingest.js';
import type { ChannelAdapter } from './channels/types.js';
import type { ConversationStore } from './memory/store.js';

/** El body crudo, para verificar firmas HMAC (p.ej. Meta Cloud API). */
export type RequestWithRawBody = FastifyRequest & { rawBody?: Buffer };

export async function buildServer(store: ConversationStore, adapter: ChannelAdapter): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: logger as FastifyBaseLogger,
    // El proxy de Coolify termina TLS; sin esto request.ip sería el del proxy.
    trustProxy: true,
    // 256 KB alcanza de sobra para un webhook de mensajes. El límite anterior
    // (1 MB) permitía mandar un mensaje gigante que entraba entero al prompt.
    // El tope real del texto lo pone la guarda de entrada; esto es el portero.
    bodyLimit: 262_144,
  });

  // Guardamos el body crudo además del parseado: algunos canales firman el
  // cuerpo (HMAC) y necesitan los bytes exactos, no el JSON re-serializado.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as RequestWithRawBody).rawBody = body as Buffer;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  /**
   * Límite por IP. Es la primera línea, y la más tonta: frena la fuerza bruta
   * contra el webhook antes de que llegue a tocar Redis, Postgres o el LLM.
   *
   * No reemplaza al límite POR CONTACTO (ver channels/ingest.ts): un proveedor
   * legítimo como Meta te manda todo desde un puñado de IPs, así que por IP no
   * podés distinguir 500 mensajes de un abusador de 500 de clientes distintos.
   */
  await app.register(rateLimit, {
    global: true,
    max: env.RATE_LIMIT_PER_IP,
    timeWindow: '1 minute',
    // /health lo consultan el orquestador y el balanceador todo el tiempo.
    allowList: (req) => req.url === '/health',
    // El statusCode va sí o sí: sin él, el plugin lanza el objeto como error y
    // Fastify lo convierte en un 500, que a un proveedor de webhooks le dice
    // "tu server está roto, reintentá" en vez de "bajá el ritmo".
    errorResponseBuilder: () => ({ statusCode: 429, error: 'demasiadas solicitudes' }),
  });

  app.get('/health', async () => ({ ok: true, ts: new Date().toISOString() }));

  app.get('/health/ready', async (_req, reply) => {
    const checks: Record<string, string> = { channel: adapter.name, store: env.STORE };
    let ok = true;

    if (env.STORE === 'postgres') {
      try {
        const { pool } = await import('./db/client.js');
        await pool.query('SELECT 1');
        checks.postgres = 'ok';
      } catch (err) {
        checks.postgres = err instanceof Error ? err.message : 'error';
        ok = false;
      }
    }

    if (adapter.mode === 'queue') {
      try {
        const { redis } = await import('./redis/client.js');
        await redis.ping();
        checks.redis = 'ok';
      } catch (err) {
        checks.redis = err instanceof Error ? err.message : 'error';
        ok = false;
      }
    }

    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  const ctx = makeChannelContext(store, loadConfig(), adapter.name, adapter.mode === 'queue');
  await adapter.registerRoutes(app, ctx);

  return app;
}
