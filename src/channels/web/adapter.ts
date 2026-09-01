import { randomBytes } from 'node:crypto';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { issueSessionId, verifySessionId } from '../../security/index.js';
import type { ChannelAdapter, ChannelContext } from '../types.js';

/**
 * Canal WEB: una mini UI de chat para probar el agente en el navegador, sin
 * WhatsApp ni base de datos. Es `inline` (request/respuesta), así que no usa
 * la cola de Redis. También sirve de ejemplo de cómo conectar tu propia app.
 */

/**
 * El secreto con el que se firman las sesiones. Si no configuraste
 * SESSION_SECRET se genera uno al azar por proceso: las sesiones del demo se
 * pierden al reiniciar, que para un demo está perfecto. En producción ponlo,
 * o cada deploy le borra la conversación a todo el mundo.
 */
const SESSION_SECRET = env.SESSION_SECRET ?? randomBytes(32).toString('hex');

export const webAdapter: ChannelAdapter = {
  name: 'web',
  mode: 'inline',

  async registerRoutes(app: FastifyInstance, ctx: ChannelContext): Promise<void> {
    // Sirve la carpeta web/ (la UI) en la raíz.
    await app.register(fastifyStatic, { root: path.resolve(process.cwd(), 'web'), prefix: '/' });

    // La app web postea aquí y recibe la respuesta del agente en el acto.
    app.post('/chat', async (request, reply) => {
      const body = (request.body ?? {}) as { sessionId?: string; text?: string };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) return reply.code(400).send({ error: 'texto vacío' });

      /**
       * El id de sesión lo emite y firma el SERVER.
       *
       * Antes el cliente mandaba el sessionId que quisiera y el server le abría
       * (o le devolvía) esa conversación. Con eso, sabiendo o adivinando el id
       * de otra persona podías retomar SU conversación y pedirle al agente que
       * te resumiera lo que habían hablado. Un id inventado ya no valida la
       * firma: recibe una sesión nueva y vacía.
       */
      const verified = verifySessionId(body.sessionId, SESSION_SECRET);
      const signedId = verified ? (body.sessionId as string) : issueSessionId(SESSION_SECRET);
      const sessionId = verified ?? signedId.slice(0, signedId.lastIndexOf('.'));

      const answer = await ctx.runInline({
        externalContactId: `web:${sessionId}`,
        externalConversationId: `web:${sessionId}`,
        text,
        isInbound: true,
      });

      // El cliente guarda el id firmado y lo manda en el próximo mensaje.
      return reply.send({ reply: answer ?? '', sessionId: signedId });
    });

    logger.info(`canal web listo → abre http://localhost:${env.PORT} para chatear`);
  },

  // El web responde en la misma llamada HTTP, no necesita enviar por fuera.
  async sendOutbound() {
    return {};
  },
};
