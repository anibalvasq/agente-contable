import type { FastifyInstance } from 'fastify';
import { logger } from '../../logger.js';
import { notifyDocument } from '../../notifications/index.js';
import type { ChannelAdapter, ChannelContext, SendOutboundInput } from '../types.js';
import { telegramEnv } from './env.js';
import { isAllowedExtension, MAX_FILE_BYTES, safeFileName, saveToInbox } from './inbox.js';
import { parseUpdate, type TelegramUpdate } from './parse.js';

const API = `https://api.telegram.org/bot${telegramEnv.TELEGRAM_BOT_TOKEN}`;
const POLL_TIMEOUT_S = 30;
const MAX_MESSAGE_CHARS = 4096;

/**
 * Llama a la Bot API. NO usa integrations/http.ts a propósito: ese helper loguea
 * la URL al reintentar, y aquí la URL lleva el token del bot.
 */
async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !json?.ok) {
    throw new Error(`telegram.${method}: ${res.status} ${json?.description ?? res.statusText}`);
  }
  return json.result as T;
}

/** Descarga un archivo del cliente. La URL lleva el token: tampoco se loguea. */
async function download(fileId: string): Promise<Buffer> {
  const { file_path } = await call<{ file_path?: string }>('getFile', { file_id: fileId });
  if (!file_path) throw new Error('telegram.getFile: sin file_path');
  const res = await fetch(`https://api.telegram.org/file/bot${telegramEnv.TELEGRAM_BOT_TOKEN}/${file_path}`);
  if (!res.ok) throw new Error(`telegram.download: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Canal Telegram por LONG POLLING: el server le pregunta a Telegram si hay
 * mensajes nuevos, en vez de esperar que Telegram le pegue a una URL.
 *
 * Por eso funciona en tu computadora sin túnel ni dominio, y no hay webhook que
 * autenticar. Es `inline` (sin Redis): cada mensaje corre el agente y responde.
 * Corre UNA sola instancia: dos procesos haciendo polling con el mismo token se
 * pisan (Telegram responde 409).
 */
export const telegramAdapter: ChannelAdapter = {
  name: 'telegram',
  mode: 'inline',

  registerRoutes(app: FastifyInstance, ctx: ChannelContext): void {
    const abort = new AbortController();
    // Un mensaje a la vez por chat: si el usuario manda dos seguidos, el
    // segundo espera al primero y ve su respuesta en el historial.
    const chains = new Map<string, Promise<void>>();

    if (telegramEnv.TELEGRAM_ALLOWED_USER_IDS.length === 0) {
      logger.warn(
        'telegram: TELEGRAM_ALLOWED_USER_IDS vacío — cualquiera que encuentre el bot puede usar tu saldo del LLM',
      );
    }

    async function handle(update: TelegramUpdate): Promise<void> {
      const message = parseUpdate(update);
      if (!message) return;

      const allowed = telegramEnv.TELEGRAM_ALLOWED_USER_IDS;
      if (allowed.length > 0 && !allowed.includes(String(update.message?.from?.id))) {
        logger.warn({ userId: update.message?.from?.id }, 'telegram: usuario no autorizado; se ignora');
        return;
      }

      const chatId = message.externalContactId;

      // Un adjunto se guarda en la bandeja y el agente recibe solo el AVISO de
      // que llegó (nombre ya saneado), nunca el contenido.
      if (message.attachment) {
        const { fileName, fileId, size } = message.attachment;
        if (!isAllowedExtension(fileName) || (size ?? 0) > MAX_FILE_BYTES) {
          await telegramAdapter.sendOutbound({
            externalContactId: chatId,
            text: 'Solo puedo recibir archivos Excel, CSV, PDF, XML o imágenes, de hasta 20 MB.',
          });
          return;
        }
        try {
          const saved = await saveToInbox(chatId, fileName, await download(fileId));
          logger.info({ chatId, archivo: saved }, 'telegram: documento guardado en la bandeja');
          void notifyDocument({ externalContactId: chatId, contactName: message.name ?? null, savedAs: saved, channel: 'telegram' });
          message.text = `[El cliente envió el archivo "${safeFileName(fileName)}"] ${message.text}`.trim();
        } catch (err) {
          logger.error({ err: String(err), chatId }, 'telegram: no se pudo guardar el documento');
          await telegramAdapter.sendOutbound({
            externalContactId: chatId,
            text: 'No pude recibir ese archivo. ¿Puedes enviarlo de nuevo?',
          });
          return;
        }
      }
      // "escribiendo…" dura ~5 s en Telegram; se renueva mientras el agente piensa.
      const typing = setInterval(() => void call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {}), 4_000);
      void call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      try {
        const reply = await ctx.runInline(message);
        if (reply) await telegramAdapter.sendOutbound({ externalContactId: chatId, text: reply });
      } catch (err) {
        logger.error({ err, chatId }, 'telegram: falló el turno');
        await telegramAdapter
          .sendOutbound({ externalContactId: chatId, text: 'Tuve un problema técnico. Inténtalo de nuevo en un momento.' })
          .catch(() => {});
      } finally {
        clearInterval(typing);
      }
    }

    async function poll(): Promise<void> {
      // Si el bot tuvo un webhook, getUpdates falla con 409 hasta quitarlo.
      await call('deleteWebhook', { drop_pending_updates: false }).catch((err) =>
        logger.warn({ err: String(err) }, 'telegram: no se pudo limpiar el webhook'),
      );

      const me = await call<{ username?: string }>('getMe', {});
      logger.info({ bot: `@${me.username}` }, 'canal telegram listo (long polling)');

      let offset = 0;
      while (!abort.signal.aborted) {
        try {
          const updates = await call<TelegramUpdate[]>(
            'getUpdates',
            { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message'] },
            abort.signal,
          );
          for (const update of updates) {
            offset = update.update_id + 1;
            const key = String(update.message?.chat?.id ?? 'x');
            const prev = chains.get(key) ?? Promise.resolve();
            const next = prev.then(() => handle(update)).catch((err) => logger.error({ err }, 'telegram: error en handle'));
            chains.set(key, next);
            void next.finally(() => {
              if (chains.get(key) === next) chains.delete(key);
            });
          }
        } catch (err) {
          if (abort.signal.aborted) return;
          logger.error({ err: String(err) }, 'telegram: error en getUpdates; reintento en 5 s');
          await sleep(5_000);
        }
      }
    }

    app.addHook('onClose', async () => abort.abort());
    // Si el token es inválido queremos verlo al arrancar, no en silencio.
    void poll().catch((err) => {
      logger.error({ err: String(err) }, 'telegram: no se pudo iniciar el canal (¿token válido?)');
      process.exit(1);
    });
  },

  async sendOutbound({ externalContactId, text }: SendOutboundInput): Promise<{ messageId?: string }> {
    // Texto plano (sin parse_mode): el modelo puede escribir _ o * sueltos y
    // Markdown mal cerrado hace que Telegram rechace el mensaje entero.
    let last: { message_id?: number } = {};
    for (let i = 0; i < text.length; i += MAX_MESSAGE_CHARS) {
      last = await call('sendMessage', { chat_id: externalContactId, text: text.slice(i, i + MAX_MESSAGE_CHARS) });
    }
    return { messageId: last.message_id != null ? String(last.message_id) : undefined };
  },
};
