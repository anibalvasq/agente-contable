/**
 * Guarda de SALIDA: lo último que pasa antes de que el mensaje llegue al
 * usuario. Es la capa más barata y la que más disgustos evita, porque acá ya no
 * importa CÓMO lo convencieron al modelo — importa qué está por decir.
 *
 * Revisa tres cosas:
 *
 *  1. LARGO. WhatsApp corta en 4096 caracteres. Un mensaje más largo hace que
 *     la API del proveedor devuelva error, el job reintente y el usuario no
 *     reciba nada. Recortar es mejor que fallar.
 *
 *  2. FUGA DEL SYSTEM PROMPT. Si la respuesta repite textualmente un tramo
 *     largo de tus instrucciones, el modelo las está filtrando. Se compara por
 *     secuencias de 8 palabras: una frase suelta en común es normal, ocho
 *     palabras seguidas idénticas no lo son.
 *
 *  3. PATRONES PROHIBIDOS. Los definís vos en agent.yaml. El caso típico es
 *     que el bot no prometa descuentos, reembolsos ni plazos de entrega que no
 *     puede garantizar.
 *
 * Cuando algo se viola, NO se manda la respuesta original: se manda el fallback
 * configurado. Es preferible un "dejame confirmarlo y te aviso" a un bot que
 * regala 90% de descuento porque alguien se lo pidió con la frase correcta.
 */

export interface OutputGuardOptions {
  /** El system prompt del turno, para detectar si se está filtrando. */
  systemPrompt: string;
  /** Regex (como strings) que la respuesta no puede matchear. */
  forbidden?: string[];
  /** Tope de caracteres del mensaje saliente. */
  maxLength?: number;
  /** Qué mandar cuando se bloquea la respuesta. */
  fallback?: string;
}

export interface OutputGuardResult {
  /** El texto a enviar: el original, uno recortado, o el fallback. */
  reply: string;
  /** true si se reemplazó por el fallback. */
  blocked: boolean;
  /** Qué se violó. Vacío = todo bien. */
  violations: string[];
}

const DEFAULT_MAX_LENGTH = 4_000;
const DEFAULT_FALLBACK = 'Dejame confirmar ese dato y te respondo en un momento.';

/** Largo de la secuencia de palabras que se considera "copiado textual". */
const SHINGLE = 8;

export function guardReply(reply: string, options: OutputGuardOptions): OutputGuardResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  const fallback = options.fallback ?? DEFAULT_FALLBACK;
  const violations: string[] = [];

  let text = reply.trim();

  if (leaksSystemPrompt(text, options.systemPrompt)) violations.push('fuga-de-instrucciones');

  for (const pattern of options.forbidden ?? []) {
    const re = compile(pattern);
    if (re && re.test(text)) violations.push(`prohibido:${pattern}`);
  }

  // Una fuga o un patrón prohibido invalidan la respuesta entera: no se recorta,
  // se reemplaza. Recortar dejaría pasar la mitad del problema.
  if (violations.length > 0) {
    return { reply: fallback, blocked: true, violations };
  }

  if (text.length > maxLength) {
    violations.push('demasiado-largo');
    text = truncate(text, maxLength);
  }

  return { reply: text, blocked: false, violations };
}

/**
 * ¿La respuesta contiene 8 palabras seguidas del system prompt? Se normaliza
 * (minúsculas, sin acentos ni puntuación) para que no lo esquive un cambio de
 * mayúsculas o una coma de más.
 */
function leaksSystemPrompt(reply: string, systemPrompt: string): boolean {
  const replyWords = words(reply);
  if (replyWords.length < SHINGLE) return false;

  const promptShingles = new Set<string>();
  const promptWords = words(systemPrompt);
  for (let i = 0; i + SHINGLE <= promptWords.length; i++) {
    promptShingles.add(promptWords.slice(i, i + SHINGLE).join(' '));
  }
  if (promptShingles.size === 0) return false;

  for (let i = 0; i + SHINGLE <= replyWords.length; i++) {
    if (promptShingles.has(replyWords.slice(i, i + SHINGLE).join(' '))) return true;
  }
  return false;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // saca los acentos
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Corta en el último límite de oración o palabra, no a mitad de una. */
function truncate(text: string, maxLength: number): string {
  const cut = text.slice(0, maxLength);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  if (lastStop > maxLength * 0.6) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

/** Un regex malo en agent.yaml no debe voltear el proceso en runtime. */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}
