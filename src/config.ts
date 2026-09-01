import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Personalidad, conocimiento y límites del agente, en un YAML editable por
 * no-devs. Toda la "identidad" del bot vive en config/agent.yaml — el código no
 * cambia entre un agente y otro, solo este archivo.
 */

/**
 * Los límites de seguridad. TODO tiene default, así que un agent.yaml viejo
 * sigue funcionando sin tocarlo: los valores de abajo son los que aplican si no
 * declarás la sección `guardrails`.
 */
const guardrailsSchema = z
  .object({
    /**
     * Qué hacer cuando se detecta un intento de manipulación en el mensaje:
     *   log        solo lo registra (y puedes mirarlo en tus logs).
     *   reinforce  agrega un recordatorio al final del prompt. ← default
     *   block      no llama al modelo y responde `blocked_reply`.
     * 'block' es tentador pero tiene falsos positivos: alguien que escribe
     * "ignora lo anterior, mejor quiero el modelo azul" es un cliente, no un
     * atacante. Empieza en 'reinforce' y mira tus logs antes de endurecerlo.
     */
    on_injection: z.enum(['log', 'reinforce', 'block']).default('reinforce'),

    /** Tope de caracteres del mensaje entrante. WhatsApp corta en 4096. */
    max_input_chars: z.number().int().positive().default(4_000),
    /** Tope de caracteres de la respuesta. Más largo, la API del canal falla. */
    max_reply_chars: z.number().int().positive().default(4_000),

    /**
     * Techo de tokens del historial que se re-envía en cada turno. Es la
     * palanca que más mueve tu factura: el historial viaja entero en CADA
     * llamada, así que el costo crece con el cuadrado de la conversación.
     */
    max_history_tokens: z.number().int().positive().default(8_000),

    /** Presupuesto por conversación en su ventana. 0 = sin tope. */
    max_tokens_per_conversation: z.number().int().nonnegative().default(200_000),
    /** Ventana del presupuesto por conversación, en horas. */
    token_window_hours: z.number().positive().default(24),
    /**
     * Techo global de gasto diario. 0 = sin tope.
     *
     * OJO con dejarlo bajo: cuando se cruza, TODOS los clientes empiezan a
     * recibir `budget_reply` en lugar del agente. Es un corte de emergencia,
     * no un acelerador — tiene que estar por encima de tu día más ocupado.
     *
     * Para dimensionarlo:
     *   conversaciones_por_día × 40.000 × 3
     *
     * (Una conversación típica de WhatsApp gasta ~40.000 tokens, porque el
     * historial viaja entero en cada turno. El ×3 es el margen que hace que un
     * día bueno no lo dispare, pero un loop con otro bot sí.)
     *
     * El default asume ~150 conversaciones diarias. Si vendes más que eso,
     * súbelo — o deja que `npm run setup` lo calcule por ti.
     */
    max_tokens_per_day: z.number().int().nonnegative().default(20_000_000),

    /**
     * Regex (como texto) que la respuesta NO puede contener. El caso típico es
     * que el bot no prometa lo que no puedes cumplir.
     * Ejemplo: ['\\b\\d{2,3}\\s*%\\s*(de\\s+)?descuento', 'garantizo|te aseguro']
     */
    forbidden_patterns: z.array(z.string()).default([]),

    /** Qué responder cuando la guarda de salida bloquea la respuesta. */
    blocked_reply: z.string().default('Déjame confirmar ese dato con el equipo y te respondo en un momento.'),
    /** Qué responder cuando se agotó el presupuesto de tokens. */
    budget_reply: z
      .string()
      .default('Estoy con muchas consultas en este momento. Un asesor te escribe en breve.'),
  })
  .default({});

const schema = z.object({
  name: z.string().default('Asistente'),
  // El system prompt: quién es, cómo habla, qué puede y qué no.
  system_prompt: z.string().min(1, 'Falta system_prompt en agent.yaml'),
  // Mensaje de bienvenida opcional (lo usa el demo web).
  greeting: z.string().optional(),
  // Base de conocimiento simple: la herramienta search_knowledge busca aquí.
  knowledge: z.array(z.string()).default([]),
  // Límites de seguridad y de gasto. Ver arriba.
  guardrails: guardrailsSchema,
});

export type AgentConfig = z.infer<typeof schema>;
export type Guardrails = AgentConfig['guardrails'];

let cached: AgentConfig | null = null;

export function loadConfig(): AgentConfig {
  if (cached) return cached;

  const file = path.resolve(process.cwd(), env.AGENT_CONFIG_PATH);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    logger.error({ file }, 'no se encontró el archivo de configuración del agente (AGENT_CONFIG_PATH)');
    process.exit(1);
  }

  const parsed = schema.safeParse(parse(raw));
  if (!parsed.success) {
    const detalle = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    logger.error(`agent.yaml inválido:\n${detalle}`);
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}
