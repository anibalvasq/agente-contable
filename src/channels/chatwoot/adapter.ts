import type { FastifyInstance } from 'fastify';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { sharedSecretValid } from '../../security/index.js';
import type { ChannelAdapter, ChannelContext, HandoffInput, NormalizedMessage, SendOutboundInput } from '../types.js';

const WEBHOOK_PATH = '/webhooks/chatwoot';

/**
 * ┌───────────────────────────────────────────────────────────┐
 * │  STUB — Chatwoot. Esqueleto para que lo completes.         │
 * └───────────────────────────────────────────────────────────┘
 *
 * Chatwoot es un frontend open-source de atención. Conectás WhatsApp a Chatwoot,
 * y Chatwoot te avisa por webhook. Para terminarlo:
 *
 * 1. En Chatwoot: Settings → Integrations → Webhooks → agrega
 *      https://TU-DOMINIO/webhooks/chatwoot   (evento: message_created)
 * 2. Env vars (agrega su validación en un env.ts como el de cloud-api):
 *      CHATWOOT_BASE_URL, CHATWOOT_API_TOKEN, CHATWOOT_ACCOUNT_ID
 * 3. Completa parseInbound (abajo) y sendOutbound (más abajo).
 */
export const chatwootAdapter: ChannelAdapter = {
  name: 'chatwoot',
  mode: 'queue',

  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void {
    logger.warn('canal chatwoot: STUB. Completa parseInbound/sendOutbound en src/channels/chatwoot/adapter.ts');

    app.post(WEBHOOK_PATH, async (request, reply) => {
      // Un stub sin autenticar NO es inofensivo. Aunque sendOutbound todavía no
      // esté implementado, este webhook crea contactos, encola trabajos y hace
      // correr el LLM: cualquiera que conozca la URL puede gastarte el saldo.
      // Por eso pide el mismo secreto compartido que el canal de GHL.
      if (!sharedSecretValid(request.headers['x-webhook-secret'], env.WEBHOOK_SECRET)) {
        if (env.WEBHOOK_REQUIRE_SIGNATURE) {
          logger.warn({ ip: request.ip }, 'webhook chatwoot rechazado: secreto inválido');
          return reply.code(401).send({ error: 'no autorizado' });
        }
        logger.warn({ ip: request.ip }, 'webhook chatwoot SIN VERIFICAR (WEBHOOK_REQUIRE_SIGNATURE=false)');
      }

      const message = parseInbound(request.body);
      if (message) await ctx.enqueue(message);
      // 200 aunque el payload venga incompleto: un 4xx haría reintentar para siempre.
      return reply.code(200).send({ ok: true });
    });
  },

  /**
   * En Chatwoot el handoff se marca con un LABEL en la conversación, que es lo
   * que el equipo filtra en su bandeja. Suele ir junto con dos cosas más:
   * cambiar el `status` a "open" y asignar un agente o un equipo.
   *
   * Para completarlo:
   *   POST {CHATWOOT_BASE_URL}/api/v1/accounts/{ACCOUNT_ID}/conversations/{id}/labels
   *     headers: { api_access_token: CHATWOOT_API_TOKEN }
   *     body:    { labels: ['bot-handoff'] }
   *
   *   Ojo: ese endpoint REEMPLAZA los labels de la conversación, no los suma.
   *   Si ya usas labels para otra cosa, léelos primero (GET al mismo path) y
   *   manda la lista completa. Es el error clásico de esta integración.
   *
   * Mientras no lo implementes, el handoff igual funciona: el kit apaga el
   * agente y te manda el mail. Lo que falta es que tu equipo lo vea en Chatwoot.
   */
  async handoff(_input: HandoffInput): Promise<void> {
    throw new Error('chatwoot.handoff sin implementar (ver comentarios del archivo)');
  },

  async sendOutbound(_input: SendOutboundInput): Promise<{ messageId?: string }> {
    // TODO: POST {CHATWOOT_BASE_URL}/api/v1/accounts/{ACCOUNT_ID}/conversations/{conversationId}/messages
    //   headers: { api_access_token: CHATWOOT_API_TOKEN }
    //   body: { content: input.text, message_type: 'outgoing' }
    // Chatwoot envía por conversación → usa input.externalConversationId.
    throw new Error('chatwoot.sendOutbound sin implementar (ver comentarios del archivo)');
  },
};

/**
 * Chatwoot manda `message_created`. El texto está en `content`, el contacto en
 * `sender`, la conversación en `conversation.id`. Filtra los salientes
 * (message_type === 'incoming'). Ajusta los campos a tu instancia.
 */
function parseInbound(payload: unknown): NormalizedMessage | null {
  const p = payload as {
    event?: string;
    message_type?: string;
    content?: string;
    sender?: { id?: number | string; name?: string; phone_number?: string };
    conversation?: { id?: number | string };
  };
  if (p?.event !== 'message_created' || p?.message_type !== 'incoming') return null;

  const text = typeof p.content === 'string' ? p.content.trim() : '';
  const contactId = p.sender?.id != null ? String(p.sender.id) : null;
  if (!text || !contactId) return null;

  return {
    externalContactId: contactId,
    externalConversationId: p.conversation?.id != null ? String(p.conversation.id) : null,
    text,
    name: p.sender?.name ?? null,
    phone: p.sender?.phone_number ?? null,
    isInbound: true,
  };
}
