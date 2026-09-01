import { env } from '../env.js';
import { logger } from '../logger.js';
import { sendAlert } from './email.js';

/**
 * Avisos. Hay DOS audiencias distintas y conviene no mezclarlas:
 *
 *  1. EL EQUIPO que atiende. Se entera dentro de la herramienta que ya usa —
 *     una etiqueta en GHL, un label en Chatwoot. No le sirve un mail: no vive
 *     en el mail, vive en el CRM. Por eso el aviso al equipo lo hace el
 *     ADAPTADOR DE CANAL, que es el único que sabe cómo se marca una
 *     conversación en esa plataforma.
 *
 *  2. VOS, que lo estás construyendo. Te enteras por mail, porque los eventos
 *     que te importan (se abandonó un turno, se agotó el presupuesto) no tienen
 *     dónde aparecer en el CRM y no vas a estar mirando los logs a las 3 AM.
 *
 * Un handoff dispara las dos: el equipo tiene que atender al cliente, y tú
 * quieres saber con qué frecuencia tu agente se rinde.
 */

export interface HandoffNotice {
  conversationId: string;
  contactId: string;
  contactName: string | null;
  /** Ids en la plataforma externa: los que el adaptador necesita para etiquetar. */
  externalContactId: string;
  externalConversationId: string | null;
  reason: string;
}

export interface ErrorNotice {
  /** Agrupa errores equivalentes para no repetir el mismo mail. */
  key: string;
  title: string;
  detail: string;
  context?: Record<string, unknown>;
}

/**
 * Un humano tiene que tomar esta conversación.
 *
 * Los dos avisos van por separado y ninguno puede tumbar al otro: si GHL está
 * caído, el mail igual sale; si Resend está caído, la etiqueta igual se pone.
 */
export async function notifyHandoff(notice: HandoffNotice): Promise<void> {
  await Promise.allSettled([marcarEnElCanal(notice), avisarPorMail(notice)]);
}

/**
 * Marca la conversación en la plataforma donde trabaja el equipo.
 *
 * Cada canal lo hace a su manera y algunos no tienen forma de hacerlo (la Cloud
 * API de Meta no tiene CRM detrás: ahí el único registro es el `agent_enabled`
 * del kit y el mail). Por eso `handoff` es opcional en ChannelAdapter.
 */
async function marcarEnElCanal(notice: HandoffNotice): Promise<void> {
  try {
    // Import dinámico: el registry ya está cargado, esto no abre nada nuevo.
    const { getActiveAdapter } = await import('../channels/registry.js');
    const adapter = await getActiveAdapter();

    if (!adapter.handoff) {
      logger.info(
        { channel: adapter.name, conversationId: notice.conversationId },
        'el canal no tiene forma nativa de marcar el handoff; queda en agent_enabled y en el mail',
      );
      return;
    }

    await adapter.handoff({
      externalContactId: notice.externalContactId,
      externalConversationId: notice.externalConversationId,
      contactName: notice.contactName,
      reason: notice.reason,
    });
    logger.info({ channel: adapter.name, conversationId: notice.conversationId }, 'handoff marcado en el canal');
  } catch (err) {
    logger.error({ err, conversationId: notice.conversationId }, 'no se pudo marcar el handoff en el canal');
  }
}

async function avisarPorMail(notice: HandoffNotice): Promise<void> {
  await sendAlert({
    // La clave incluye la conversación: dos handoffs de clientes distintos son
    // dos avisos, pero el mismo cliente insistiendo no te llena la casilla.
    key: `handoff:${notice.conversationId}`,
    subject: `[agente] Handoff a humano — ${notice.contactName ?? notice.externalContactId}`,
    body: [
      'Tu agente derivó una conversación a una persona y dejó de responder.',
      '',
      `Contacto:     ${notice.contactName ?? '(sin nombre)'} (${notice.externalContactId})`,
      `Motivo:       ${notice.reason}`,
      `Conversación: ${notice.conversationId}`,
      '',
      'El agente NO se reactiva solo — es una decisión humana y deliberada.',
      'Para volver a activarlo: pon agent_enabled = true en esa conversación.',
    ].join('\n'),
  });
}

/**
 * Algo se rompió y necesita que mires. Va solo por mail: el equipo de atención
 * no puede hacer nada con un error de infraestructura.
 */
export async function notifyError(notice: ErrorNotice): Promise<void> {
  const contexto = notice.context
    ? ['', 'Contexto:', ...Object.entries(notice.context).map(([k, v]) => `  ${k}: ${String(v)}`)]
    : [];

  await sendAlert({
    key: notice.key,
    subject: `[agente] ${notice.title}`,
    body: [notice.detail, ...contexto, '', `Entorno: ${env.NODE_ENV} · canal: ${env.CHANNEL_ADAPTER}`].join('\n'),
  });
}
