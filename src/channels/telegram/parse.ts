import type { NormalizedMessage } from '../types.js';

/** Un archivo que el usuario adjuntó. Nada de su contenido se lee aquí. */
export interface Attachment {
  fileId: string;
  /** Nombre que mandó el usuario: es texto de un tercero, se sanea antes de usarlo. */
  fileName: string;
  size?: number;
}

/** Lo mínimo de un `Update` de la Bot API que usamos. */
export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    text?: string;
    caption?: string;
    document?: { file_id: string; file_name?: string; file_size?: number };
    photo?: Array<{ file_id: string; file_size?: number }>;
    from?: { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string };
    chat?: { id: number; type?: string };
  };
}

/**
 * Traduce un update de Telegram al mensaje normalizado del kit.
 *
 * Devuelve null para todo lo que el agente no atiende: grupos, mensajes de otros
 * bots, y cualquier cosa sin texto (fotos, audios, stickers). Un bot que
 * contesta en un grupo o a otro bot puede entrar en un loop que gasta saldo.
 */
export function parseUpdate(update: TelegramUpdate): (NormalizedMessage & { attachment?: Attachment }) | null {
  const m = update.message;
  if (!m || m.chat?.type !== 'private' || !m.from || m.from.is_bot) return null;

  const text = (typeof m.text === 'string' ? m.text : (m.caption ?? '')).trim();

  // Un adjunto sin texto también es un mensaje: el cliente manda el archivo y ya.
  // De las fotos Telegram manda varios tamaños; la última es la más grande.
  const photo = m.photo?.at(-1);
  const attachment: Attachment | undefined = m.document
    ? { fileId: m.document.file_id, fileName: m.document.file_name ?? 'documento', size: m.document.file_size }
    : photo
      ? { fileId: photo.file_id, fileName: 'foto.jpg', size: photo.file_size }
      : undefined;
  if (!text && !attachment) return null;

  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || m.from.username || null;

  return {
    // En un chat privado el id del chat coincide con el del usuario; usamos el
    // del chat porque es el que sendMessage necesita como destino.
    externalContactId: String(m.chat.id),
    externalConversationId: `telegram:${m.chat.id}`,
    externalMessageId: `${update.update_id}`,
    text,
    name,
    isInbound: true,
    metadata: { telegramUserId: m.from.id, username: m.from.username ?? null },
    attachment,
  };
}
