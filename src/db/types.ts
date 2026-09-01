/**
 * Tipos genéricos de la capa conversacional. Un agente cualquiera necesita
 * contactos, conversaciones y mensajes con memoria — nada de dominio aquí.
 *
 * Los ids del sistema externo (el número de WhatsApp, el id de contacto de
 * GHL, etc.) se guardan como `external_*`, sin atarse a ningún canal.
 */

export type MessageRole = 'user' | 'assistant' | 'tool';
export type ConversationStatus = 'open' | 'handed_off' | 'closed';

export interface ContactRow {
  id: string;
  external_id: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface ConversationRow {
  id: string;
  contact_id: string;
  external_id: string | null;
  status: ConversationStatus;
  // Interruptor: cuando un humano toma la conversación, se apaga el agente.
  agent_enabled: boolean;
  last_message_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  external_message_id: string | null;
  role: MessageRole;
  content: string | null;
  tool_calls: unknown[] | null;
  tool_call_id: string | null;
  created_at: Date;
}
