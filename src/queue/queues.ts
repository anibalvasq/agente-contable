import { Queue } from 'bullmq';
import { queueConnection } from '../redis/client.js';

export const MESSAGE_QUEUE = 'inbound-messages';
export const JOB_REPLY = 'reply';

export interface MessageJob {
  conversationId: string;
  contactId: string;
  /**
   * La respuesta ya generada, si el turno llegó a producirla. La guardamos en
   * el job para que un reintento por fallo de ENVÍO no vuelva a llamar al
   * modelo: sería pagar dos veces y escribir dos veces en el historial.
   *
   * undefined = todavía no se generó. null = se generó y no hubo nada que decir.
   */
  reply?: string | null;
  /** Cuántas veces se reprogramó esperando el lock. Ver worker.ts. */
  rescheduled?: number;
}

/**
 * Cola de respuestas. Un trabajo = "responder a esta conversación con lo que
 * haya en su buffer". El debounce se logra reprogramando el trabajo cada vez
 * que llega un mensaje nuevo (ver queue/buffer.ts).
 */
export const messageQueue = new Queue<MessageJob>(MESSAGE_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2_000 },
    removeOnComplete: { age: 3_600, count: 1_000 },
    // Los fallidos se guardan más: son los que hay que mirar.
    removeOnFail: { age: 86_400 * 7 },
  },
});
