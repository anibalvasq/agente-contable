import { randomUUID } from 'node:crypto';
import type { ConversationStatus } from '../db/types.js';
import type {
  AppendMessageInput,
  Contact,
  Conversation,
  ConversationStore,
  HistoryMessage,
  UpsertContactInput,
} from './store.js';

/**
 * Store en RAM. Se pierde al reiniciar el proceso — a propósito: es para el
 * demo (`npm run demo`, `npm run chat`) y para probar sin levantar Postgres.
 * En producción usá STORE=postgres.
 */
export class MemoryStore implements ConversationStore {
  private contactsByExternal = new Map<string, Contact>();
  private contactsById = new Map<string, Contact>();
  private conversations = new Map<string, Conversation & { lastMessageAt: number | null }>();
  private conversationsByExternal = new Map<string, string>();
  private messages = new Map<string, (HistoryMessage & { externalMessageId: string | null })[]>();
  private seenEvents = new Set<string>();
  private seenMessageIds = new Set<string>();

  async upsertContact(input: UpsertContactInput): Promise<Contact> {
    const existing = this.contactsByExternal.get(input.externalId);
    const contact: Contact = existing ?? {
      id: randomUUID(),
      externalId: input.externalId,
      phone: null,
      name: null,
      email: null,
      metadata: {},
    };
    if (input.phone) contact.phone = input.phone;
    if (input.name) contact.name = input.name;
    if (input.email) contact.email = input.email;
    if (input.metadata && Object.keys(contact.metadata).length === 0) contact.metadata = input.metadata;
    this.contactsByExternal.set(input.externalId, contact);
    this.contactsById.set(contact.id, contact);
    return contact;
  }

  async getContact(contactId: string): Promise<Contact | null> {
    return this.contactsById.get(contactId) ?? null;
  }

  async getOrCreateConversation(contactId: string, externalId?: string | null): Promise<Conversation> {
    if (externalId) {
      const existingId = this.conversationsByExternal.get(externalId);
      if (existingId) return this.conversations.get(existingId)!;
    } else {
      for (const c of this.conversations.values()) {
        if (c.contactId === contactId) return c;
      }
    }
    const conv = {
      id: randomUUID(),
      contactId,
      externalId: externalId ?? null,
      status: 'open' as ConversationStatus,
      agentEnabled: true,
      lastMessageAt: null,
    };
    this.conversations.set(conv.id, conv);
    if (externalId) this.conversationsByExternal.set(externalId, conv.id);
    this.messages.set(conv.id, []);
    return conv;
  }

  async findConversation(conversationId: string): Promise<Conversation | null> {
    return this.conversations.get(conversationId) ?? null;
  }

  async appendMessage(conversationId: string, m: AppendMessageInput): Promise<void> {
    if (m.externalMessageId) {
      if (this.seenMessageIds.has(m.externalMessageId)) return;
      this.seenMessageIds.add(m.externalMessageId);
    }
    const list = this.messages.get(conversationId) ?? [];
    list.push({
      role: m.role,
      content: m.content ?? null,
      toolCalls: m.toolCalls ?? null,
      toolCallId: m.toolCallId ?? null,
      externalMessageId: m.externalMessageId ?? null,
    });
    this.messages.set(conversationId, list);
  }

  async getHistory(conversationId: string, limit: number): Promise<HistoryMessage[]> {
    const list = this.messages.get(conversationId) ?? [];
    return list.slice(-limit).map(({ role, content, toolCalls, toolCallId }) => ({ role, content, toolCalls, toolCallId }));
  }

  async setAgentEnabled(conversationId: string, enabled: boolean): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (c) c.agentEnabled = enabled;
  }

  async setStatus(conversationId: string, status: ConversationStatus): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (c) c.status = status;
  }

  async touchLastMessage(conversationId: string): Promise<void> {
    const c = this.conversations.get(conversationId);
    if (c) c.lastMessageAt = Date.now();
  }

  // El store en RAM ignora el payload de auditoría: es para el demo, y no hay
  // nada que auditar en un proceso que pierde todo al reiniciar.
  async markEventSeen(provider: string, externalId: string): Promise<boolean> {
    const key = `${provider}:${externalId}`;
    if (this.seenEvents.has(key)) return false;
    this.seenEvents.add(key);
    return true;
  }

  async close(): Promise<void> {
    /* nada que cerrar */
  }
}
