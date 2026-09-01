import type { HistoryMessage } from '../memory/store.js';

/**
 * Estimación de tokens y recorte del historial POR TAMAÑO, no por cantidad de
 * mensajes.
 *
 * Por qué importa: recortar a "los últimos 40 mensajes" parece razonable hasta
 * que una herramienta devuelve un JSON de 30 KB. Ahí esos 40 mensajes son
 * 100.000 tokens, la llamada cuesta veinte veces lo previsto, y si el modelo
 * tiene menos contexto directamente falla. El costo de un agente de WhatsApp se
 * va casi todo en historial re-enviado en cada turno.
 *
 * La estimación es deliberadamente aproximada (~4 caracteres por token). Contar
 * exacto exige el tokenizer de cada modelo, que cambia entre proveedores y
 * agrega una dependencia pesada. Para decidir "¿esto entra o lo recorto?" sobra,
 * y el margen del 15% de abajo cubre el error.
 */

const CHARS_PER_TOKEN = 4;
/** Cada mensaje suma overhead de formato (rol, separadores) en la API. */
const OVERHEAD_PER_MESSAGE = 4;
/** Margen de seguridad sobre la estimación, porque siempre se queda corta. */
const SAFETY = 1.15;

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(m: HistoryMessage): number {
  let total = OVERHEAD_PER_MESSAGE + estimateTokens(m.content);
  // Las tool_calls viajan serializadas y pesan; ignorarlas subestima mucho.
  if (m.toolCalls?.length) total += estimateTokens(JSON.stringify(m.toolCalls));
  return total;
}

export function estimateHistoryTokens(history: HistoryMessage[]): number {
  return Math.ceil(history.reduce((sum, m) => sum + estimateMessageTokens(m), 0) * SAFETY);
}

/**
 * Recorta el historial desde el principio hasta que entre en `maxTokens`,
 * conservando siempre los mensajes más recientes.
 *
 * Cuida dos invariantes que la API exige y que un recorte ingenuo rompe:
 *
 *  - Un `assistant` con tool_calls DEBE ir seguido de un `tool` por cada
 *    llamada. Si el corte separa el par, la API rechaza el request entero.
 *  - El historial no puede EMPEZAR con un `tool` huérfano, por lo mismo.
 */
export function fitHistory(history: HistoryMessage[], maxTokens: number): HistoryMessage[] {
  if (history.length === 0) return history;

  let start = 0;
  let total = estimateHistoryTokens(history);

  while (start < history.length && total > maxTokens) {
    total -= Math.ceil(estimateMessageTokens(history[start]!) * SAFETY);
    start++;
  }

  // Si el corte dejó `tool` sueltos al principio (su `assistant` quedó afuera),
  // los descartamos hasta el primer mensaje que puede abrir una conversación.
  while (start < history.length && history[start]!.role === 'tool') start++;

  return start === 0 ? history : history.slice(start);
}
