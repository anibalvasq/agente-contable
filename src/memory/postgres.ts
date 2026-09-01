import { closePool, query, queryOne } from '../db/client.js';
import type { ContactRow, ConversationRow, ConversationStatus } from '../db/types.js';
import type {
  AppendMessageInput,
  Contact,
  Conversation,
  ConversationStore,
  HistoryMessage,
  UpsertContactInput,
} from './store.js';

/** Store persistente sobre Postgres. Toda su SQL vive aquí, a la vista. */
export class PostgresStore implements ConversationStore {
  async upsertContact(input: UpsertContactInput): Promise<Contact> {
    const row = await queryOne<ContactRow>(
      `
      INSERT INTO contacts (external_id, phone, name, email, metadata)
      VALUES ($1, $2, $3, $4, COALESCE($5::jsonb, '{}'::jsonb))
      ON CONFLICT (external_id) DO UPDATE SET
        phone = COALESCE(EXCLUDED.phone, contacts.phone),
        name  = COALESCE(EXCLUDED.name,  contacts.name),
        email = COALESCE(EXCLUDED.email, contacts.email)
      RETURNING *
      `,
      [
        input.externalId,
        input.phone ?? null,
        input.name ?? null,
        input.email ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      ],
    );
    return toContact(row!);
  }

  async getContact(contactId: string): Promise<Contact | null> {
    const row = await queryOne<ContactRow>('SELECT * FROM contacts WHERE id = $1', [contactId]);
    return row ? toContact(row) : null;
  }

  async getOrCreateConversation(contactId: string, externalId?: string | null): Promise<Conversation> {
    if (externalId) {
      const row = await queryOne<ConversationRow>(
        `
        INSERT INTO conversations (contact_id, external_id)
        VALUES ($1, $2)
        ON CONFLICT (external_id) DO UPDATE SET external_id = EXCLUDED.external_id
        RETURNING *
        `,
        [contactId, externalId],
      );
      return toConversation(row!);
    }

    const existing = await queryOne<ConversationRow>(
      'SELECT * FROM conversations WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1',
      [contactId],
    );
    if (existing) return toConversation(existing);

    const row = await queryOne<ConversationRow>(
      'INSERT INTO conversations (contact_id) VALUES ($1) RETURNING *',
      [contactId],
    );
    return toConversation(row!);
  }

  async findConversation(conversationId: string): Promise<Conversation | null> {
    const row = await queryOne<ConversationRow>('SELECT * FROM conversations WHERE id = $1', [conversationId]);
    return row ? toConversation(row) : null;
  }

  async appendMessage(conversationId: string, m: AppendMessageInput): Promise<void> {
    await query(
      `
      INSERT INTO messages (conversation_id, external_message_id, role, content, tool_calls, tool_call_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT DO NOTHING
      `,
      [
        conversationId,
        m.externalMessageId ?? null,
        m.role,
        m.content ?? null,
        m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        m.toolCallId ?? null,
      ],
    );
  }

  async getHistory(conversationId: string, limit: number): Promise<HistoryMessage[]> {
    const res = await query<{
      role: HistoryMessage['role'];
      content: string | null;
      tool_calls: unknown[] | null;
      tool_call_id: string | null;
    }>(
      `SELECT role, content, tool_calls, tool_call_id
       FROM messages WHERE conversation_id = $1
       ORDER BY created_at DESC LIMIT $2`,
      [conversationId, limit],
    );
    return res.rows
      .reverse()
      .map((r) => ({ role: r.role, content: r.content, toolCalls: r.tool_calls, toolCallId: r.tool_call_id }));
  }

  async setAgentEnabled(conversationId: string, enabled: boolean): Promise<void> {
    await query('UPDATE conversations SET agent_enabled = $2 WHERE id = $1', [conversationId, enabled]);
  }

  async setStatus(conversationId: string, status: ConversationStatus): Promise<void> {
    await query('UPDATE conversations SET status = $2 WHERE id = $1', [conversationId, status]);
  }

  async touchLastMessage(conversationId: string): Promise<void> {
    await query('UPDATE conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
  }

  async markEventSeen(provider: string, externalId: string, payload: Record<string, unknown> = {}): Promise<boolean> {
    const row = await queryOne<{ id: string }>(
      `
      INSERT INTO webhook_events (provider, external_id, payload)
      VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb))
      ON CONFLICT (provider, external_id) WHERE external_id IS NOT NULL DO NOTHING
      RETURNING id
      `,
      [provider, externalId, JSON.stringify(payload)],
    );
    return Boolean(row);
  }

  async close(): Promise<void> {
    await closePool();
  }
}

function toContact(r: ContactRow): Contact {
  return { id: r.id, externalId: r.external_id, phone: r.phone, name: r.name, email: r.email, metadata: r.metadata };
}

function toConversation(r: ConversationRow): Conversation {
  return { id: r.id, contactId: r.contact_id, externalId: r.external_id, status: r.status, agentEnabled: r.agent_enabled };
}
