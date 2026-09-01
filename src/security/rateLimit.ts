import { logger } from '../logger.js';

/**
 * Limitador de tasa por clave. Dos usos distintos en el kit:
 *
 *  1. Por IP, en las rutas HTTP (lo hace @fastify/rate-limit, ver server.ts).
 *  2. Por CONTACTO, acá — que es el que de verdad protege la billetera.
 *     Un atacante con la URL del webhook y una firma válida (o un cliente
 *     legítimo enloquecido) puede mandar 500 mensajes en un minuto. Cada uno
 *     es una llamada al LLM que pagás vos.
 *
 * Ventana FIJA, no deslizante: es menos precisa en los bordes (podés recibir
 * hasta 2x el límite justo en el cambio de ventana) pero se implementa con un
 * INCR y se entiende de una lectura. Para el caso de uso alcanza y sobra.
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Cuántos hits quedan en la ventana actual. */
  remaining: number;
  /** Cuánto falta para que se libere, en ms. */
  retryAfterMs: number;
}

export interface RateLimiter {
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Backend en RAM. Sirve para el canal web, el chat de terminal y cualquier
 * despliegue de UNA instancia. Con varias instancias cada una lleva su propia
 * cuenta, así que el límite real es limit × instancias: ahí querés el de Redis.
 */
export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.prune(now);

    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: limit - 1, retryAfterMs: 0 };
    }

    current.count += 1;
    const allowed = current.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - current.count),
      retryAfterMs: allowed ? 0 : current.resetAt - now,
    };
  }

  /** Sin esto el Map crece para siempre: una entrada por contacto que escribió. */
  private prune(now: number): void {
    if (this.windows.size < 10_000) return;
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * Backend en Redis, para cuando corrés varias instancias: todas comparten la
 * cuenta. Se usa solo en los canales por webhook, que ya tienen Redis.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly client: { incr(k: string): Promise<number>; pexpire(k: string, ms: number): Promise<number>; pttl(k: string): Promise<number> }) {}

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const redisKey = `wak:rl:${key}`;
    const count = await this.client.incr(redisKey);

    // Solo el primer hit de la ventana pone el TTL. Si lo pusiéramos en cada
    // hit, la ventana nunca vencería para un atacante que manda sin parar.
    if (count === 1) await this.client.pexpire(redisKey, windowMs);

    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      retryAfterMs: allowed ? 0 : Math.max(0, await this.client.pttl(redisKey)),
    };
  }
}

let cached: RateLimiter | null = null;

/**
 * Devuelve el limitador que corresponde al despliegue: Redis si el canal activo
 * usa cola (ya hay conexión abierta), RAM si no. El import es dinámico para que
 * el canal web nunca cargue Redis.
 */
export async function getRateLimiter(useRedis: boolean): Promise<RateLimiter> {
  if (cached) return cached;

  if (useRedis) {
    try {
      const { redis } = await import('../redis/client.js');
      cached = new RedisRateLimiter(redis);
      return cached;
    } catch (err) {
      logger.warn({ err }, 'no se pudo usar Redis para el rate limit; se usa RAM');
    }
  }

  cached = new MemoryRateLimiter();
  return cached;
}

/** Solo para los tests: vuelve a elegir backend en la próxima llamada. */
export function resetRateLimiter(): void {
  cached = null;
}
