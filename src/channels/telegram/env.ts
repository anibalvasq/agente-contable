import { z } from 'zod';

/**
 * Variables del canal Telegram. Se validan solo si este canal está activo (el
 * registry lo importa recién ahí).
 *
 * El token sale de @BotFather en Telegram: /newbot y te lo entrega.
 */
const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'Falta TELEGRAM_BOT_TOKEN (créalo con @BotFather)'),

  /**
   * Ids numéricos de Telegram autorizados a hablar con el bot, separados por
   * coma. Cualquiera que encuentre el @usuario del bot puede escribirle, y cada
   * mensaje gasta saldo del LLM: para un agente interno (p.ej. contable) esto es
   * lo que impide que un extraño use tu cuenta. Tu id lo da @userinfobot.
   */
  TELEGRAM_ALLOWED_USER_IDS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const detalle = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Config de Telegram inválida:\n${detalle}`);
  process.exit(1);
}

export const telegramEnv = parsed.data;
