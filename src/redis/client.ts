import { Redis } from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

/**
 * Conexión a Redis. Opcional: solo se importa cuando un límite (de tasa o de
 * gasto) debe compartirse entre varias instancias. Sin Redis esos contadores
 * viven en memoria de cada proceso, y en Vercel (una instancia por request
 * concurrente) eso significa que no se comparten: si necesitas el límite global,
 * este es el módulo que lo hace posible.
 */
export const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
redis.on('error', (err) => logger.error({ err }, 'error de conexión con Redis'));

export async function closeRedis(): Promise<void> {
  await redis.quit().catch(() => undefined);
}
