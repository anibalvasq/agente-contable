import type { NormalizedMessage } from '../types.js';

/**
 * Traduce el webhook de WhatsApp Cloud API a mensajes normalizados. Módulo puro
 * (sin env ni red) para poder testearlo con payloads reales.
 *
 * Un webhook puede traer varios mensajes; los de tipo distinto de texto quedan
 * con texto vacío y el pipeline los ignora. Para manejar audio/imágenes, ese es
 * el punto a extender: bajas el media por su id y lo transcribes/describes.
 */
export function parseInbound(payload: unknown): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  const body = payload as { entry?: Array<{ changes?: Array<{ value?: CloudValue }> }> };

  for (const entry of body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value) continue;

      const nameByWaId = new Map<string, string | null>();
      for (const c of value.contacts ?? []) {
        if (c?.wa_id) nameByWaId.set(c.wa_id, c?.profile?.name ?? null);
      }

      for (const msg of value.messages ?? []) {
        if (!msg?.from) continue;
        const text = msg.type === 'text' ? (msg.text?.body ?? '') : '';
        out.push({
          externalContactId: msg.from,
          externalMessageId: msg.id ?? null,
          text,
          phone: msg.from,
          name: nameByWaId.get(msg.from) ?? null,
          isInbound: true,
          metadata: { type: msg.type },
        });
      }
    }
  }

  return out;
}

interface CloudValue {
  contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  messages?: Array<{ from?: string; id?: string; type?: string; text?: { body?: string } }>;
}
