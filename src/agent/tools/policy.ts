import { logger } from '../../logger.js';
import type { Tool, ToolContext } from './index.js';

/**
 * ─────────────────────────────────────────────────────────────
 *  DÓNDE VIVE LA SEGURIDAD DE VERDAD
 * ─────────────────────────────────────────────────────────────
 *
 * Todas las capas anteriores (normalizar la entrada, vallar el contenido
 * externo, revisar la salida) reducen la probabilidad de que el modelo se
 * desvíe. Ninguna la lleva a cero, y ninguna puede: le estás pidiendo a un
 * sistema estadístico que no se deje convencer por texto, que es exactamente
 * lo que sabe hacer.
 *
 * Por eso la pregunta correcta no es "¿cómo evito que lo convenzan?" sino
 * "¿qué pasa si lo convencen?". Y la respuesta tiene que ser: nada grave,
 * porque las acciones con consecuencias están detrás de código determinista
 * que valida, no detrás de un párrafo pidiéndole al modelo que se porte bien.
 *
 * Este archivo es ese código. Frena una herramienta ANTES de ejecutarla.
 *
 * Las dos reglas que vienen de fábrica son un piso, no un techo. La regla que
 * de verdad importa la escribís vos, adentro de cada herramienta de escritura:
 *
 *   ✗ MAL   el modelo manda `descuento: 90` y la herramienta lo aplica.
 *   ✓ BIEN  la herramienta ignora el número del modelo y busca el descuento
 *           que corresponde en tu tabla de precios, según el cliente.
 *
 * Si tu herramienta de escritura confía en un número, un precio, un id o un
 * email que vino en los argumentos del modelo sin validarlo contra tu base de
 * datos, no hay guarda en este repo que te salve.
 */

export interface ToolPolicy {
  /**
   * ¿Puede el agente ejecutar herramientas de escritura en un turno donde se
   * detectó un intento de manipulación? Default: no.
   *
   * Es la regla más útil del archivo. Un atacante necesita dos cosas: que el
   * modelo le crea, y que la acción se ejecute. Esto corta la segunda incluso
   * cuando falló la primera.
   */
  allowWriteWhenFlagged: boolean;

  /**
   * Tope de herramientas de escritura por turno. Un modelo en loop puede pedir
   * "crear pedido" seis veces seguidas; el usuario recibe seis pedidos.
   */
  maxWritesPerTurn: number;
}

export const DEFAULT_TOOL_POLICY: ToolPolicy = {
  allowWriteWhenFlagged: false,
  maxWritesPerTurn: 2,
};

export interface PolicyDecision {
  allowed: boolean;
  /**
   * Qué devolverle al modelo cuando se frena. Es un dato neutro, no una
   * instrucción: ver el comentario de `runTool` en runner.ts sobre por qué no
   * se meten órdenes dentro de payloads de herramientas.
   */
  reason?: string;
}

/** Lleva la cuenta de lo que ya se ejecutó en el turno actual. */
export interface TurnUsage {
  writes: number;
}

export function newTurnUsage(): TurnUsage {
  return { writes: 0 };
}

export function checkToolPolicy(
  tool: Tool,
  ctx: ToolContext,
  usage: TurnUsage,
  policy: ToolPolicy = DEFAULT_TOOL_POLICY,
): PolicyDecision {
  // Las de lectura pasan siempre: si se ejecutan de más, no rompen nada.
  if (tool.sideEffect === 'read') return { allowed: true };

  const name = tool.definition.function.name;

  if (!policy.allowWriteWhenFlagged && ctx.injectionFlags.length > 0) {
    logger.warn(
      { tool: name, conversationId: ctx.conversationId, flags: ctx.injectionFlags },
      'POLICY: herramienta de escritura bloqueada en un turno marcado como manipulación',
    );
    return { allowed: false, reason: 'accion_no_disponible_en_este_momento' };
  }

  if (usage.writes >= policy.maxWritesPerTurn) {
    logger.warn(
      { tool: name, conversationId: ctx.conversationId, writes: usage.writes },
      'POLICY: se alcanzó el tope de herramientas de escritura del turno',
    );
    return { allowed: false, reason: 'limite_de_acciones_alcanzado' };
  }

  return { allowed: true };
}
