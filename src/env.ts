import { config } from 'dotenv';
import { z } from 'zod';

// override: true a propósito. Por defecto dotenv NO pisa variables que ya
// existan en el entorno, así que una key vieja exportada a nivel sistema le
// ganaría en silencio a la del .env. El .env es la fuente de verdad en local.
// En producción es inofensivo: no hay .env dentro del contenedor.
config({ override: true });

/**
 * Configuración del NÚCLEO. Cada adaptador de canal valida sus propias
 * variables por separado (ver src/channels/<canal>/env.ts), así el kit no
 * exige credenciales de canales que no vas a usar.
 *
 * Si algo falta o viene mal, el proceso muere al arrancar con un mensaje claro,
 * en vez de fallar a mitad de una conversación.
 */

/**
 * Variable opcional donde el string vacío significa "no configurada".
 *
 * Sin esto, copiar .env.example a .env —el primer paso de cualquiera— rompe el
 * arranque. El archivo de ejemplo trae `ALERT_EMAIL_TO=` sin valor, dotenv lo
 * carga como cadena vacía, y `.email()` la rechaza: el proceso muere con
 * "Invalid email" antes de levantar. Lo mismo pasaría con DATABASE_URL vacía.
 *
 * Una variable en blanco es una variable que no configuraste, no un error.
 */
function opcional<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/** Igual que `opcional`, pero cae en un valor por defecto en vez de undefined. */
function conDefault<T extends z.ZodTypeAny>(schema: T, valor: z.input<T>) {
  return z.preprocess((v) => (v === '' || v === undefined ? valor : v), schema);
}

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

    // Persistencia. 'memory' = todo en RAM (demo, cero configuración).
    // 'postgres' = historial persistente (necesita DATABASE_URL).
    STORE: z.enum(['memory', 'postgres']).default('memory'),
    DATABASE_URL: opcional(z.string().url()),

    // Cola de mensajes. Solo la usan los canales por webhook (Cloud API, GHL…).
    // El canal 'web' y el chat de terminal procesan en línea, sin Redis.
    REDIS_URL: conDefault(z.string().url(), 'redis://localhost:6379'),

    // Qué frontend está activo. Ver src/channels/registry.ts.
    CHANNEL_ADAPTER: z.enum(['web', 'cloud-api', 'ghl', 'chatwoot', 'ycloud']).default('web'),

    // Secreto compartido para validar webhooks (los canales que lo usan).
    WEBHOOK_SECRET: opcional(z.string()),

    /**
     * Exigir que TODOS los webhooks vengan firmados o autenticados.
     *
     * Está en true por default y así tiene que quedarse en producción. Un
     * webhook sin verificar es una puerta abierta: la URL es adivinable, y con
     * ella un tercero puede inyectar mensajes falsos, gastar tu saldo del LLM
     * y —en el canal cloud-api— hacer que tu número de WhatsApp le mande
     * mensajes a quien él elija, porque el destinatario sale del payload.
     *
     * Ponlo en false SOLO para probar en local con un túnel.
     */
    WEBHOOK_REQUIRE_SIGNATURE: z
      .string()
      .default('true')
      .transform((v) => v.toLowerCase() !== 'false'),

    /** Tope de requests por IP y por minuto en las rutas HTTP. */
    RATE_LIMIT_PER_IP: z.coerce.number().int().positive().default(120),
    /** Tope de mensajes por contacto y por minuto. Protege la billetera. */
    RATE_LIMIT_PER_CONTACT: z.coerce.number().int().positive().default(15),

    /**
     * Secreto para firmar los ids de sesión del canal web. Si no lo pones se
     * genera uno al azar al arrancar: las sesiones del demo no sobreviven a un
     * reinicio, que para un demo está bien. En producción, ponlo.
     */
    SESSION_SECRET: opcional(z.string()),

    // ── Avisos al desarrollador (Resend) ──────────────────────
    /**
     * Un agente que falla en silencio es peor que uno que no existe: el cliente
     * queda esperando y tú te enteras cuando te reclaman. Con esto, los tres
     * eventos que exigen a una persona (un handoff, un turno abandonado, el
     * presupuesto diario agotado) te llegan por mail.
     *
     * Si dejas RESEND_API_KEY vacío, no se manda nada: todo queda en los logs.
     * El kit funciona igual — pero enterarte tarde también es una decisión.
     *
     * La key sale de https://resend.com/api-keys
     */
    RESEND_API_KEY: opcional(z.string()),
    /** A quién le llegan los avisos: tú, el que está desarrollando esto. */
    ALERT_EMAIL_TO: opcional(z.string().email()),
    /**
     * Remitente. Tiene que ser de un dominio verificado en Resend.
     * `onboarding@resend.dev` viene listo para probar, pero solo puede
     * escribirle a la casilla con la que creaste la cuenta de Resend.
     */
    ALERT_EMAIL_FROM: conDefault(z.string(), 'onboarding@resend.dev'),

    // ── LLM (OpenRouter) ──────────────────────────────────────
    OPENROUTER_API_KEY: z.string().min(1, 'Falta la API key de OpenRouter'),
    OPENROUTER_BASE_URL: conDefault(z.string().url(), 'https://openrouter.ai/api/v1'),
    LLM_MODEL: conDefault(z.string(), 'anthropic/claude-sonnet-4.5'),
    LLM_MAX_TOKENS: z.coerce.number().int().positive().default(1024),
    LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.3),
    APP_URL: z.string().default(''),
    APP_TITLE: z.string().default('wa-agent-starter'),

    // ── Agente ────────────────────────────────────────────────
    AGENT_CONFIG_PATH: conDefault(z.string(), 'config/agent.yaml'),
    MESSAGE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(8_000),
    AGENT_MAX_TOOL_ITERATIONS: z.coerce.number().int().positive().default(6),
    AGENT_HISTORY_LIMIT: z.coerce.number().int().positive().default(40),
    AGENT_REPLY_ENABLED: z
      .string()
      .default('true')
      .transform((v) => v.toLowerCase() !== 'false'),
  })
  .refine((e) => e.STORE !== 'postgres' || Boolean(e.DATABASE_URL), {
    message: 'STORE=postgres requiere DATABASE_URL',
    path: ['DATABASE_URL'],
  })
  /**
   * En produccion estas dos dejaron de estar garantizadas por el compose: las
   * guardas ${VAR:?...} rompian el parseo previo de Coolify y se quitaron a
   * proposito (ver docker-compose.coolify.yml). La validacion vive aqui.
   */
  .refine((e) => e.NODE_ENV !== 'production' || Boolean(e.SESSION_SECRET), {
    message: 'falta SESSION_SECRET en produccion: generalo con `openssl rand -hex 32`',
    path: ['SESSION_SECRET'],
  })
  .refine((e) => e.NODE_ENV !== 'production' || !/:@/.test(e.DATABASE_URL ?? 'x'), {
    message: 'DATABASE_URL sin password: falta POSTGRES_PASSWORD en el entorno',
    path: ['DATABASE_URL'],
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detalle = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Configuración inválida. Revisa tu .env:\n${detalle}`);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
