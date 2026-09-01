import { Worker, type Job } from 'bullmq';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { workerConnection } from '../redis/client.js';
import { runAgent } from '../agent/runner.js';
import { notifyError } from '../notifications/index.js';
import type { AgentConfig } from '../config.js';
import type { ConversationStore } from '../memory/store.js';
import type { ChannelAdapter } from '../channels/types.js';
import { MESSAGE_QUEUE, type MessageJob } from './queues.js';
import {
  ackBuffer,
  bufferHasMessages,
  claimBuffer,
  LOCK_RENEW_MS,
  releaseLock,
  renewLock,
  reschedule,
  returnBuffer,
  takeLock,
} from './buffer.js';

const CONCURRENCY = 5;

/** Tope de veces que un turno se reprograma esperando que se libere el lock. */
const MAX_RESCHEDULES = 20;

/**
 * Procesa un turno: junta lo que el usuario escribió (debounce), corre el
 * agente y manda la respuesta por el adaptador de canal activo. Un turno a la
 * vez por conversación (lock).
 *
 * ─────────────────────────────────────────────────────────────
 *  EL TURNO ES REINTENTABLE, Y ESO ES LO IMPORTANTE
 * ─────────────────────────────────────────────────────────────
 * Un turno hace tres cosas caras y falibles: tomar los mensajes, generar la
 * respuesta (una llamada al LLM que puede tardar minutos y fallar) y enviarla
 * (una API externa que puede estar caída). BullMQ reintenta el job entero, así
 * que cada paso tiene que poder repetirse SIN duplicar su efecto:
 *
 *   tomar mensajes  → claimBuffer los mueve a una lista del job; repetir
 *                     devuelve lo mismo, no se pierden ni se duplican.
 *   generar         → la respuesta se guarda en el job. El reintento la reusa
 *                     en vez de pagar otra llamada al modelo (y de escribir
 *                     otro mensaje del asistente en el historial).
 *   enviar          → recién después se confirma (ack) y se borra la lista.
 *
 * Antes el buffer se vaciaba antes de llamar al modelo: cualquier fallo dejaba
 * al usuario sin respuesta para siempre, sin error visible.
 */
async function processTurn(
  job: Job<MessageJob>,
  store: ConversationStore,
  config: AgentConfig,
  adapter: ChannelAdapter,
): Promise<void> {
  const { conversationId, contactId } = job.data;
  const jobId = job.id ?? `${conversationId}__sin-id`;

  const token = await takeLock(conversationId);
  if (!token) {
    // Otro turno de esta conversación está corriendo. Volvemos a intentar en un
    // rato — con tope, para que un lock trabado no genere jobs para siempre.
    const attempts = (job.data.rescheduled ?? 0) + 1;
    if (attempts > MAX_RESCHEDULES) {
      logger.error({ conversationId, attempts }, 'no se pudo tomar el lock; se abandona el turno');
      return;
    }
    await reschedule(conversationId, contactId, 3_000, attempts);
    return;
  }

  // Mientras el turno corre, el lock se renueva. El TTL solo tiene que cubrir
  // el tiempo entre dos renovaciones, no la duración total del turno.
  const heartbeat = setInterval(() => {
    void renewLock(conversationId, token);
  }, LOCK_RENEW_MS);

  try {
    const conversation = await store.findConversation(conversationId);
    if (!conversation) return;

    if (!conversation.agentEnabled) {
      // Un humano tomó la conversación: los mensajes son suyos, no del agente.
      await claimBuffer(conversationId, jobId);
      await ackBuffer(conversationId, jobId);
      return;
    }

    let reply = job.data.reply;

    // Solo generamos si no hay una respuesta de un intento anterior.
    if (reply === undefined) {
      const texts = await claimBuffer(conversationId, jobId);
      if (texts.length === 0) return;

      const contact = await store.getContact(contactId);
      if (!contact) return;

      logger.info({ conversationId, messages: texts.length }, 'procesando turno');

      const result = await runAgent({
        store,
        conversation,
        contact,
        userText: texts.join('\n'),
        config,
        // Id estable del turno: si el job se reintenta, el mensaje del usuario
        // no se duplica en el historial.
        turnId: `turn:${jobId}`,
        useRedis: true,
      });

      reply = result.reply;
      await job.updateData({ ...job.data, reply });
      await store.touchLastMessage(conversationId);

      logger.info(
        {
          conversationId,
          finish: result.finish,
          tokens: result.tokens,
          tools: result.toolsUsed,
          flags: result.injectionFlags,
        },
        'turno resuelto',
      );
    }

    if (reply) {
      if (env.AGENT_REPLY_ENABLED) {
        const contact = await store.getContact(contactId);
        if (contact) {
          await adapter.sendOutbound({
            externalContactId: contact.externalId,
            text: reply,
            externalConversationId: conversation.externalId,
          });
        }
      } else {
        logger.info({ conversationId, reply }, 'AGENT_REPLY_ENABLED=false: respuesta no enviada');
      }
    }

    // Recién aquí: el turno se completó de punta a punta.
    await ackBuffer(conversationId, jobId);
  } finally {
    clearInterval(heartbeat);
    await releaseLock(conversationId, token);
  }

  // Llegaron mensajes mientras respondíamos: hay que atenderlos.
  if (await bufferHasMessages(conversationId)) {
    await reschedule(conversationId, contactId, env.MESSAGE_DEBOUNCE_MS);
  }
}

export function startWorker(store: ConversationStore, config: AgentConfig, adapter: ChannelAdapter): Worker<MessageJob> {
  const worker = new Worker<MessageJob>(MESSAGE_QUEUE, (job) => processTurn(job, store, config, adapter), {
    connection: workerConnection,
    concurrency: CONCURRENCY,
  });

  worker.on('failed', (job, err) => {
    const attemptsLeft = job ? (job.opts.attempts ?? 1) - job.attemptsMade : 0;
    logger.error(
      { err, jobId: job?.id, conversationId: job?.data?.conversationId, attemptsLeft },
      'falló un turno',
    );

    // Se agotaron los reintentos. Los mensajes que este job tenía tomados
    // vuelven al buffer: el próximo mensaje del usuario los arrastra y se
    // responde con todo el contexto. Es feo, pero es mejor que perderlos.
    if (job && attemptsLeft <= 0) {
      // Un cliente escribió y NO va a recibir respuesta. Es el error que más
      // caro sale y el único que no deja rastro visible en ningún lado: por eso
      // sale por mail y no solo al log.
      void notifyError({
        // La clave NO incluye la conversación: si se cae OpenRouter fallan
        // cientos de turnos distintos y quieres un aviso, no cientos.
        key: 'turno-abandonado',
        title: 'Un turno se abandonó tras agotar los reintentos',
        detail:
          'Un cliente escribió y el agente no pudo responderle. Sus mensajes volvieron al ' +
          'buffer: se van a procesar cuando vuelva a escribir, pero mientras tanto está esperando.',
        context: {
          conversacion: job.data.conversationId,
          job: job.id ?? '(sin id)',
          error: err instanceof Error ? err.message : String(err),
        },
      });

      void returnBuffer(job.data.conversationId, job.id ?? '')
        .then((n) => {
          if (n > 0) {
            logger.warn(
              { conversationId: job.data.conversationId, mensajes: n },
              'turno abandonado: los mensajes volvieron al buffer',
            );
          }
        })
        .catch((e) => logger.error({ err: e }, 'no se pudieron devolver los mensajes al buffer'));
    }
  });

  worker.on('error', (err) => logger.error({ err }, 'error del worker'));

  logger.info({ concurrency: CONCURRENCY, channel: adapter.name }, 'worker de mensajes iniciado');
  return worker;
}
