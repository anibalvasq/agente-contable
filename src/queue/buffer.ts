import { randomUUID } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redis } from '../redis/client.js';
import { buildJobId } from './jobId.js';
import { JOB_REPLY, messageQueue } from './queues.js';
import {
  bufKey,
  CLAIM_LUA,
  ENQUEUE_LUA,
  lockKey,
  LOCK_MS,
  pendKey,
  procKey,
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
  RETURN_LUA,
  seqKey,
  TTL,
} from './scripts.js';

/**
 * Debounce de mensajes. La gente no manda un mensaje, manda cuatro seguidos.
 * Responder a cada uno delata al bot y lo deja sin contexto. Acá se acumulan en
 * Redis y se responde UNA vez, MESSAGE_DEBOUNCE_MS después del último.
 *
 * (Solo lo usan los canales por webhook. El canal web responde en línea.)
 *
 * Las claves y los scripts Lua viven en scripts.ts, con la explicación de por
 * qué cada operación tiene que ser atómica.
 */

export { LOCK_RENEW_MS } from './scripts.js';

// ─────────────────────────────────────────────────────────────
//  Encolar (con debounce)
// ─────────────────────────────────────────────────────────────

/** Agrega el texto al buffer y (re)programa la respuesta. */
export async function enqueueMessage(conversationId: string, contactId: string, text: string): Promise<void> {
  const [jobId, previous] = (await redis.eval(
    ENQUEUE_LUA,
    3,
    bufKey(conversationId),
    seqKey(conversationId),
    pendKey(conversationId),
    text,
    String(TTL),
    conversationId,
  )) as [string, string];

  // Primero agendamos el nuevo, después cancelamos el viejo. Al revés, un fallo
  // entre ambos pasos dejaría la conversación sin ningún job agendado y al
  // usuario sin respuesta. En este orden, el peor caso es un job de más — que
  // encuentra el buffer vacío y no hace nada.
  await messageQueue.add(JOB_REPLY, { conversationId, contactId }, { jobId, delay: env.MESSAGE_DEBOUNCE_MS });
  if (previous) await cancelJob(previous);

  logger.debug({ conversationId, jobId }, 'mensaje encolado');
}

/** Cancela una respuesta programada que todavía no arrancó (el debounce). */
async function cancelJob(jobId: string): Promise<void> {
  try {
    const job = await messageQueue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    // Si ya está 'active', llegamos tarde: lo maneja el lock del worker.
    if (state === 'delayed' || state === 'waiting') await job.remove();
  } catch (err) {
    logger.debug({ err, jobId }, 'no se pudo cancelar el trabajo pendiente');
  }
}

/**
 * Reprograma un turno sin pasar por el debounce (el buffer ya tiene datos).
 *
 * `rescheduled` viaja en el job para que el worker pueda cortar: sin ese
 * contador, una conversación con el lock trabado generaría un job nuevo cada
 * 3 segundos indefinidamente.
 */
export async function reschedule(
  conversationId: string,
  contactId: string,
  delayMs: number,
  rescheduled = 0,
): Promise<void> {
  const seq = await redis.incr(seqKey(conversationId));
  await redis.expire(seqKey(conversationId), TTL);
  const jobId = buildJobId(conversationId, seq);
  await messageQueue.add(JOB_REPLY, { conversationId, contactId, rescheduled }, { jobId, delay: delayMs });
  await redis.set(pendKey(conversationId), jobId, 'EX', TTL);
}

// ─────────────────────────────────────────────────────────────
//  Tomar / confirmar / devolver  (claim / ack / return)
// ─────────────────────────────────────────────────────────────

/** Toma los mensajes acumulados para este job. Ver CLAIM_LUA en scripts.ts. */
export async function claimBuffer(conversationId: string, jobId: string): Promise<string[]> {
  const texts = (await redis.eval(
    CLAIM_LUA,
    2,
    bufKey(conversationId),
    procKey(conversationId, jobId),
    String(TTL),
  )) as string[];
  return texts ?? [];
}

/** El turno terminó bien: los mensajes tomados ya no hacen falta. */
export async function ackBuffer(conversationId: string, jobId: string): Promise<void> {
  await redis.del(procKey(conversationId, jobId));
}

/** El job se abandonó: los mensajes vuelven al frente del buffer. */
export async function returnBuffer(conversationId: string, jobId: string): Promise<number> {
  const n = (await redis.eval(
    RETURN_LUA,
    2,
    procKey(conversationId, jobId),
    bufKey(conversationId),
    String(TTL),
  )) as number;
  return n ?? 0;
}

export async function bufferHasMessages(conversationId: string): Promise<boolean> {
  return (await redis.llen(bufKey(conversationId))) > 0;
}

// ─────────────────────────────────────────────────────────────
//  Lock por conversación
// ─────────────────────────────────────────────────────────────

/** Un turno a la vez por conversación: dos en paralelo cruzarían respuestas. */
export async function takeLock(conversationId: string): Promise<string | null> {
  const token = randomUUID();
  const ok = await redis.set(lockKey(conversationId), token, 'PX', LOCK_MS, 'NX');
  return ok ? token : null;
}

/** Extiende el lock mientras el turno corre. Solo si sigue siendo nuestro. */
export async function renewLock(conversationId: string, token: string): Promise<boolean> {
  try {
    const ok = await redis.eval(RENEW_LOCK_LUA, 1, lockKey(conversationId), token, String(LOCK_MS));
    return ok === 1;
  } catch (err) {
    logger.warn({ err, conversationId }, 'no se pudo renovar el lock');
    return false;
  }
}

export async function releaseLock(conversationId: string, token: string): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_LUA, 1, lockKey(conversationId), token);
  } catch (err) {
    logger.warn({ err, conversationId }, 'no se pudo liberar el lock; vence solo');
  }
}
