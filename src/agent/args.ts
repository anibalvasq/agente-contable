/**
 * Saneamiento de los argumentos que manda el modelo a una herramienta.
 *
 * Segunda línea de defensa: el LLM tiende a rellenar campos aunque no tenga el
 * dato ("" , 0, un valor inventado). No confíes en lo que llega crudo; pásalo
 * por aquí. Sale de pruebas reales, no de la teoría.
 */

/** El valor que puede usar un enum para "el usuario no lo dijo". */
export const NOT_SAID = 'not_said';

/** Texto real, o undefined. Descarta "", espacios y el centinela NOT_SAID. */
export function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  if (clean.length === 0) return undefined;
  if (clean === NOT_SAID) return undefined;
  return clean;
}

/**
 * Número positivo, o undefined. El 0 se descarta a propósito: en la mayoría de
 * los casos un 0 es el modelo rellenando el campo, no un dato real.
 */
export function positiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** Lista de strings dentro de `allowed`, no vacía, o undefined. */
export function list<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const clean = value.filter((v): v is T => typeof v === 'string' && allowed.includes(v as T));
  return clean.length > 0 ? clean : undefined;
}
