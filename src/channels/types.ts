import type { FastifyInstance } from 'fastify';
import type { AgentConfig } from '../config.js';
import type { ConversationStore } from '../memory/store.js';

/**
 * La abstracción central del kit. El "cerebro" del agente es siempre el mismo;
 * el ADAPTADOR DE CANAL lo conecta con dónde llegan los mensajes (WhatsApp
 * Cloud API, GHL, Chatwoot, YCloud, tu app web…).
 *
 * Un adaptador hace tres cosas: recibir (parsear el webhook a un mensaje
 * normalizado), enviar (mandar la respuesta), y montar sus rutas HTTP.
 */

/** Un mensaje, ya traducido a la forma común, venga del canal que venga. */
export interface NormalizedMessage {
  /** Id del contacto en el sistema externo (número de WhatsApp, id de GHL…). */
  externalContactId: string;
  externalConversationId?: string | null;
  externalMessageId?: string | null;
  text: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  /** true si lo escribió el usuario; false si es un eco de algo que enviamos. */
  isInbound: boolean;
  metadata?: Record<string, unknown>;
}

/** Lo que el runtime le da al adaptador para procesar mensajes. */
export interface ChannelContext {
  store: ConversationStore;
  config: AgentConfig;
  /** Encola un entrante para procesarlo async (canales por webhook). */
  enqueue(message: NormalizedMessage): Promise<void>;
  /** Procesa un entrante en línea y devuelve la respuesta (canal web). */
  runInline(message: NormalizedMessage): Promise<string | null>;
}

export interface SendOutboundInput {
  externalContactId: string;
  text: string;
  externalConversationId?: string | null;
}

/** Lo que necesita un canal para marcar una conversación como "la toma un humano". */
export interface HandoffInput {
  externalContactId: string;
  externalConversationId?: string | null;
  contactName?: string | null;
  /** Por qué se derivó, en una frase. Lo lee el equipo, no el cliente. */
  reason: string;
}

export interface ChannelAdapter {
  readonly name: string;
  /**
   * 'queue' = webhook async (WhatsApp real): valida, parsea, encola, responde
   * 200; el worker responde después vía sendOutbound.
   * 'inline' = request/respuesta (web): corre el agente y devuelve la respuesta
   * en la misma llamada HTTP.
   */
  readonly mode: 'queue' | 'inline';
  /** Monta las rutas HTTP del canal (webhook, UI…). */
  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void | Promise<void>;
  /** Envía la respuesta del agente por el canal. Los inline pueden dejarlo no-op. */
  sendOutbound(input: SendOutboundInput): Promise<{ messageId?: string }>;

  /**
   * Marca la conversación en la plataforma para que el equipo la vea y la
   * atienda. OPCIONAL, y ese "opcional" no es pereza: no todos los canales
   * tienen dónde marcarla.
   *
   * En la práctica el handoff se dispara con ETIQUETAS, y cada frontend tiene
   * las suyas:
   *
   *   ghl       una tag en el contacto → dispara tus workflows y aparece en
   *             el filtro que ya usa tu equipo.
   *   chatwoot  un label en la conversación (+ cambiar el assignee).
   *   cloud-api nada: la API de Meta no tiene CRM detrás. El único registro
   *             es el agent_enabled del kit y el mail al desarrollador.
   *
   * Apagar el agente (`agent_enabled = false`) lo hace el kit siempre, en
   * `escalate_to_human`. Esto es lo OTRO: que el humano se entere, donde
   * trabaja. Un handoff que solo apaga el bot deja al cliente esperando.
   */
  handoff?(input: HandoffInput): Promise<void>;
}
