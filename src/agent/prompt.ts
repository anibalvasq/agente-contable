import type { AgentConfig } from '../config.js';
import { untrustedContentRule } from './guards/untrusted.js';

/**
 * Arma el system prompt del turno. Tiene tres bloques, y el ORDEN importa:
 *
 *  1. IDENTIDAD (de agent.yaml) — quién es y cómo habla. Va primero porque lo
 *     que abre el prompt fija el marco con el que el modelo lee todo lo demás.
 *  2. CONTEXTO — lo que sabemos ahora mismo: el nombre del usuario, la fecha.
 *  3. REGLAS DE SEGURIDAD — cómo tratar el contenido externo.
 *
 * Aquí es donde en la Fase 3 entran el resumen de la conversación, la etapa
 * actual y los hechos recordados del contacto. Los puntos están marcados.
 */
export interface PromptContext {
  config: AgentConfig;
  contactName: string | null;
  /** Id de la valla de datos externos de este turno. Ver guards/untrusted.ts. */
  fenceId: string;
}

export function buildSystemPrompt({ config, contactName, fenceId }: PromptContext): string {
  const bloques: string[] = [config.system_prompt.trim()];

  bloques.push(contexto(contactName));

  // TODO(fase 3): resumen de la conversación (memoria de mediano plazo).
  // TODO(fase 3): hechos recordados del contacto (memoria de largo plazo).
  // TODO(fase 3): etapa actual y objetivo del tramo (orquestador).

  bloques.push(untrustedContentRule(fenceId));

  return bloques.join('\n\n');
}

/**
 * El bloque que cambia en cada turno. La fecha va aquí y no en el YAML por una
 * razón práctica: sin ella el modelo inventa el día de hoy, y un agente que
 * agenda o cita horarios con la fecha equivocada es peor que no tenerlo.
 */
function contexto(contactName: string | null): string {
  const ahora = new Date().toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    dateStyle: 'full',
    timeStyle: 'short',
  });

  const quienEs = contactName
    ? `El usuario se llama ${contactName}.`
    : 'Todavía no sabes el nombre del usuario; pregúntaselo con naturalidad si viene al caso.';

  return ['## Contexto', '', `Ahora mismo son las ${ahora} (hora de Lima).`, quienEs].join('\n');
}
