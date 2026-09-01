import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { requestJson } from '../../integrations/http.js';
import { hmacSha256Valid, sharedSecretValid } from '../../security/index.js';
import type { RequestWithRawBody } from '../../server.js';
import type { ChannelAdapter, ChannelContext, SendOutboundInput } from '../types.js';
import { cloudEnv } from './env.js';
import { parseInbound } from './parse.js';

const WEBHOOK_PATH = '/webhooks/cloud-api';

/**
 * Adaptador de WhatsApp Cloud API (la API oficial de Meta, sin intermediarios).
 *
 * Configuración en Meta: WhatsApp → Configuration → Webhook:
 *   Callback URL: https://TU-DOMINIO/webhooks/cloud-api
 *   Verify token: el mismo que pusiste en META_VERIFY_TOKEN
 *   Suscríbete al campo "messages".
 */
export const cloudApiAdapter: ChannelAdapter = {
  name: 'cloud-api',
  mode: 'queue',

  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void {
    // GET: el handshake de verificación que Meta hace una vez al configurar.
    app.get(WEBHOOK_PATH, async (request, reply) => {
      const q = request.query as Record<string, string>;
      // safeEqual y no ===: el verify token es un secreto, y comparar con ===
      // filtra su contenido carácter por carácter según cuánto tarda el rechazo.
      if (q['hub.mode'] === 'subscribe' && sharedSecretValid(q['hub.verify_token'], cloudEnv.META_VERIFY_TOKEN)) {
        return reply.code(200).send(q['hub.challenge']);
      }
      return reply.code(403).send('forbidden');
    });

    // POST: los mensajes entrantes.
    app.post(WEBHOOK_PATH, async (request, reply) => {
      if (cloudEnv.META_APP_SECRET) {
        const raw = (request as RequestWithRawBody).rawBody ?? Buffer.from('');
        if (!hmacSha256Valid(raw, request.headers['x-hub-signature-256'], cloudEnv.META_APP_SECRET)) {
          logger.warn({ ip: request.ip }, 'webhook cloud-api rechazado: firma HMAC inválida');
          return reply.code(401).send({ error: 'firma inválida' });
        }
      }
      // Sin secreto solo se llega aquí con WEBHOOK_REQUIRE_SIGNATURE=false, que
      // env.ts ya obligó a poner de forma explícita. Lo dejamos anotado en cada
      // request para que nadie descubra en producción que estaba así.
      else {
        logger.warn({ ip: request.ip }, 'webhook cloud-api SIN VERIFICAR (WEBHOOK_REQUIRE_SIGNATURE=false)');
      }

      // Respondemos 200 rápido y encolamos: Meta reintenta si tardamos.
      for (const message of parseInbound(request.body)) {
        await ctx.enqueue(message);
      }
      return reply.code(200).send({ ok: true });
    });

    logger.info({ path: WEBHOOK_PATH }, 'canal cloud-api listo');
  },

  async sendOutbound({ externalContactId, text }: SendOutboundInput): Promise<{ messageId?: string }> {
    const url = `https://graph.facebook.com/${cloudEnv.META_GRAPH_VERSION}/${cloudEnv.META_PHONE_NUMBER_ID}/messages`;
    const res = await requestJson<{ messages?: Array<{ id: string }> }>(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cloudEnv.META_ACCESS_TOKEN}` },
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: externalContactId,
        type: 'text',
        text: { body: text },
      },
      context: 'cloud-api.send',
    });
    return { messageId: res.messages?.[0]?.id };
  },
};
