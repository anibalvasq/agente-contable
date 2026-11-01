import { createHash } from 'node:crypto';
import type { AgentConfig } from '../config.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { runAgent } from '../agent/runner.js';
import { guardUserInput } from '../agent/guards/index.js';
import { getRateLimiter } from '../security/rateLimit.js';
import type { ConversationStore } from '../memory/store.js';
import type { ChannelContext, NormalizedMessage } from './types.js';

const DEDUPE_WINDOW_MS = 60_000;
const MINUTE_MS = 60_000;

/**
 * Id de idempotencia sintético para cuando el canal no manda un id de mensaje.
 * Contacto + texto + ventana de 1 minuto: un reintento cae en la misma ventana
 * y se descarta; el mismo texto diez minutos después entra bien.
 */
function synthEventId(contactId: string, text: string): string {
  const window = Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  const hash = createHash('sha256').update(`${contactId}|${text}|${window}`).digest('hex');
  return `synthetic-${hash.slice(0, 32)}`;
}

/**
 * Arma el ChannelContext: encapsula el pipeline común (guarda de entrada,
 * límite por contacto, idempotencia, upsert de contacto/conversación, encolado
 * o ejecución en línea) para que cada adaptador solo se ocupe de parsear y
 * enviar.
 *
 * El orden de los controles no es casual: primero lo barato y lo que descarta
 * más (¿hay texto? ¿este contacto se pasó de la raya? ¿ya vimos este evento?),
 * y recién al final lo que cuesta dinero.
 */
export function makeChannelContext(
  store: ConversationStore,
  config: AgentConfig,
  providerName: string,
  useRedis: boolean,
): ChannelContext {
  /**
   * Límite por contacto: el que de verdad protege la billetera.
   *
   * Por IP no alcanza — Meta te manda todos los webhooks desde unas pocas IPs,
   * así que un abusador y cien clientes legítimos se ven igual. Por contacto sí
   * se distinguen: un número que manda 60 mensajes en un minuto no es un
   * cliente, es un loop con otro bot o alguien probando cuánto te puede costar.
   */
  async function withinRate(externalContactId: string): Promise<boolean> {
    const limiter = await getRateLimiter(useRedis);
    const { allowed } = await limiter.hit(
      `contact:${providerName}:${externalContactId}`,
      env.RATE_LIMIT_PER_CONTACT,
      MINUTE_MS,
    );
    if (!allowed) {
      logger.warn(
        { provider: providerName, externalContactId, limit: env.RATE_LIMIT_PER_CONTACT },
        'contacto por encima del límite de mensajes; se descarta',
      );
    }
    return allowed;
  }

  /**
   * Normaliza el texto antes de que toque nada. Se hace aquí, en la puerta, para
   * que lo que se guarda en Redis y en Postgres ya esté limpio: sin caracteres
   * invisibles usados para esconder instrucciones, y con un tope de largo.
   *
   * El runner vuelve a pasar la guarda sobre el texto completo del turno — es
   * idempotente, y ahí lo que interesa son las banderas, no la limpieza.
   */
  function clean(raw: string): string | null {
    const { text, truncated, flags } = guardUserInput(raw, { maxLength: config.guardrails.max_input_chars });
    if (truncated) logger.warn({ provider: providerName }, 'mensaje entrante recortado por largo');
    if (flags.length > 0) logger.warn({ provider: providerName, flags }, 'mensaje entrante con patrones sospechosos');
    return text || null;
  }

  return {
    store,
    config,

    async runInline(message: NormalizedMessage): Promise<string | null> {
      const text = clean(message.text);
      if (!text) return null;

      if (!(await withinRate(message.externalContactId))) return null;

      const contact = await store.upsertContact({
        externalId: message.externalContactId,
        name: message.name,
      });
      const conversation = await store.getOrCreateConversation(contact.id, message.externalConversationId ?? null);
      if (!conversation.agentEnabled) return null;

      const { reply } = await runAgent({ store, conversation, contact, userText: text, config, useRedis });
      await store.touchLastMessage(conversation.id);
      return reply;
    },
  };
}
