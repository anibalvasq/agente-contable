import type { ConversationStatus, MessageRole } from '../db/types.js';

/**
 * `ConversationStore` es la abstracción de persistencia del kit.
 *
 * Hay dos implementaciones (elegidas por env STORE):
 *  - `postgres` (memory/postgres.ts): historial persistente.
 *  - `memory`   (memory/memory.ts):   todo en RAM, para el demo y probar sin DB.
 *
 * Guarda contactos, conversaciones y mensajes, y ofrece idempotencia de
 * webhooks. No sabe nada del canal ni del dominio del agente.
 */

export interface Contact {
  id: string;
  externalId: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  metadata: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  contactId: string;
  externalId: string | null;
  status: ConversationStatus;
  agentEnabled: boolean;
}

/** Un mensaje del historial, en el formato que consume el runner del agente. */
export interface HistoryMessage {
  role: MessageRole;
  content: string | null;
  toolCalls?: unknown[] | null;
  toolCallId?: string | null;
}

export interface AppendMessageInput extends HistoryMessage {
  externalMessageId?: string | null;
}

export interface UpsertContactInput {
  externalId: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ConversationStore {
  upsertContact(input: UpsertContactInput): Promise<Contact>;
  getContact(contactId: string): Promise<Contact | null>;
  getOrCreateConversation(contactId: string, externalId?: string | null): Promise<Conversation>;
  findConversation(conversationId: string): Promise<Conversation | null>;

  appendMessage(conversationId: string, message: AppendMessageInput): Promise<void>;
  /** Historial en orden cronológico (viejo → nuevo), acotado a `limit`. */
  getHistory(conversationId: string, limit: number): Promise<HistoryMessage[]>;

  setAgentEnabled(conversationId: string, enabled: boolean): Promise<void>;
  setStatus(conversationId: string, status: ConversationStatus): Promise<void>;
  touchLastMessage(conversationId: string): Promise<void>;

  /**
   * Idempotencia de webhooks. Devuelve true si el evento es NUEVO (procesalo);
   * false si ya lo habíamos visto (es un reintento del proveedor).
   *
   * `payload` se guarda como auditoría. La tabla webhook_events existía desde
   * la primera migración con ese propósito, pero se insertaba siempre `{}`: el
   * día que algo salía mal no había con qué reconstruir qué había llegado.
   *
   * No guardes acá el texto del mensaje: ya está en `messages`, y duplicar
   * datos personales en una tabla que nadie purga es pedir problemas. Van los
   * identificadores y los metadatos del evento.
   */
  markEventSeen(provider: string, externalId: string, payload?: Record<string, unknown>): Promise<boolean>;

  close(): Promise<void>;
}
