import { logger } from '../../../logger.js';
import { notifyHandoff } from '../../../notifications/index.js';
import { text } from '../../args.js';
import type { Tool } from '../index.js';

/**
 * Handoff a un humano. La herramienta que ningún agente de WhatsApp debería no
 * tener, y la que casi ningún tutorial incluye.
 *
 * Hace TRES cosas, y las tres hacen falta:
 *
 *  1. Apaga el agente en esa conversación (`agent_enabled = false`). Es lo que
 *     leen ingest.ts y worker.ts para dejar de responder.
 *  2. Marca la conversación en la plataforma donde trabaja el equipo — una tag
 *     en GHL, un label en Chatwoot. Lo hace el adaptador de canal, porque es el
 *     único que sabe cómo se marca en cada frontend.
 *  3. Te avisa a tú por mail, porque quieres saber con qué frecuencia tu agente
 *     se rinde y por qué.
 *
 * Si solo haces la 1, el bot se calla y el cliente queda esperando a alguien
 * que no sabe que lo están esperando. Ese es el handoff roto más común.
 *
 * IMPORTANTE: reactivar el agente es una decisión HUMANA y deliberada, así que
 * no hay ninguna herramienta que lo vuelva a prender. Se hace desde tu panel
 * (o con un endpoint propio protegido). Si el modelo pudiera reactivarse solo,
 * bastaría convencerlo para saltarse el handoff.
 */
export const escalateToHuman: Tool = {
  // Cambia el estado de la conversación y saca al agente de la jugada: es una
  // acción con consecuencias reales, aunque no toque dinero.
  sideEffect: 'write',

  definition: {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Deriva la conversación a una persona del equipo y deja de responder automáticamente. ' +
        'Usala si el usuario pide hablar con un humano, si está molesto o hay un reclamo, ' +
        'o si te piden algo que no puedes resolver con tus herramientas.',
      parameters: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Por qué derivás, en una frase. Lo lee el equipo, no el cliente.',
          },
        },
        required: ['reason'],
        additionalProperties: false,
      },
    },
  },

  async run(args, ctx) {
    const reason = text(args.reason) ?? 'sin motivo indicado';

    // 1. Apagar el agente. Va PRIMERO y sin red: si esto falla, la herramienta
    //    falla y el modelo se entera. Lo que no puede pasar es que el bot crea
    //    que derivó y siga respondiendo.
    await ctx.store.setAgentEnabled(ctx.conversationId, false);
    await ctx.store.setStatus(ctx.conversationId, 'handed_off');

    logger.warn(
      { conversationId: ctx.conversationId, contactId: ctx.contactId, contactName: ctx.contactName, reason },
      'HANDOFF: conversación derivada a un humano',
    );

    // 2 y 3. Avisar al equipo (por el canal) y al desarrollador (por mail).
    //
    // Los ids externos salen del store: la herramienta trabaja con ids internos,
    // pero el canal necesita los suyos para etiquetar al contacto correcto.
    const [contact, conversation] = await Promise.all([
      ctx.store.getContact(ctx.contactId),
      ctx.store.findConversation(ctx.conversationId),
    ]);

    if (contact) {
      // No se espera con await a que termine bien: los avisos no pueden
      // demorar ni romper la respuesta al cliente. notifyHandoff ya atrapa
      // sus propios errores y los loguea.
      await notifyHandoff({
        conversationId: ctx.conversationId,
        contactId: ctx.contactId,
        contactName: ctx.contactName,
        externalContactId: contact.externalId,
        externalConversationId: conversation?.externalId ?? null,
        reason,
      });
    }

    return {
      escalated: true,
      // Dato neutro para el modelo: que sepa qué pasó, sin instrucciones adentro.
      // El "qué decir ahora" es responsabilidad del system prompt, no del payload.
      status: 'la conversación quedó asignada a una persona del equipo',
    };
  },
};
