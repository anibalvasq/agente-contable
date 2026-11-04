/**
 * Cliente mínimo de la API de mensajes de Anthropic (https://api.anthropic.com/v1/messages).
 *
 * Va con `fetch` y sin SDK a propósito: el despliegue usa `npm ci` y esto evita una dependencia
 * nueva para una sola llamada. La key es la de QUIEN pregunta y vive solo dentro de la llamada:
 * ningún error, log ni respuesta la incluye.
 */

const URL_MENSAJES = 'https://api.anthropic.com/v1/messages';
const VERSION_API = '2023-06-01';
const REINTENTOS = 2;

export type TipoErrorAnthropic = 'clave_invalida' | 'sin_saldo' | 'limite' | 'rechazada' | 'no_disponible';

export class ErrorAnthropic extends Error {
  constructor(
    readonly tipo: TipoErrorAnthropic,
    readonly status: number,
    /** Cuánto esperar antes de reintentar, si Anthropic lo indicó. */
    readonly reintentarMs?: number,
  ) {
    // El mensaje es solo el tipo: nunca el cuerpo de la respuesta ni la key.
    super(`anthropic_${tipo}_${status}`);
  }
}

export interface BloqueTexto {
  type: 'text';
  text: string;
}
export interface BloqueToolUse {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface BloqueToolResult {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
export type Bloque = BloqueTexto | BloqueToolUse | BloqueToolResult;

export interface MensajeAnthropic {
  role: 'user' | 'assistant';
  content: string | Bloque[];
}

export interface PeticionAnthropic {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MensajeAnthropic[];
  tools?: { name: string; description: string; input_schema: unknown }[];
}

export interface RespuestaAnthropic {
  content: Bloque[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Quita cualquier "sk-ant-…" de un texto antes de que llegue a un log o a un error. */
export function redactarClaves(texto: string): string {
  return texto.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…');
}

function clasificar(status: number, cuerpo: string): TipoErrorAnthropic {
  if (status === 401 || status === 403) return 'clave_invalida';
  if (status === 429) return 'limite';
  if (status >= 500 || status === 529) return 'no_disponible';
  // Sin crédito en la Console llega como 400: se distingue para decirle a la persona qué hacer.
  if (status === 400 && /credit balance|billing/i.test(cuerpo)) return 'sin_saldo';
  return 'rechazada';
}

const dormir = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function llamarAnthropic(
  apiKey: string,
  peticion: PeticionAnthropic,
  deps: { fetchFn?: typeof fetch; esperar?: (ms: number) => Promise<void> } = {},
): Promise<RespuestaAnthropic> {
  const fetchFn = deps.fetchFn ?? fetch;
  const esperar = deps.esperar ?? dormir;

  for (let intento = 0; ; intento++) {
    let r: Response;
    try {
      r = await fetchFn(URL_MENSAJES, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': VERSION_API, 'content-type': 'application/json' },
        body: JSON.stringify(peticion),
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      // Red caída o timeout: se trata como indisponibilidad (sin adjuntar el error original).
      if (intento < REINTENTOS) {
        await esperar(500 * 3 ** intento);
        continue;
      }
      throw new ErrorAnthropic('no_disponible', 0);
    }

    if (r.ok) return (await r.json()) as RespuestaAnthropic;

    const cuerpo = await r.text().catch(() => '');
    const tipo = clasificar(r.status, cuerpo);
    const reintentable = tipo === 'limite' || tipo === 'no_disponible';
    const retryAfter = Number(r.headers.get('retry-after'));
    const espera = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 3_000) : 500 * 3 ** intento;
    if (reintentable && intento < REINTENTOS) {
      await esperar(espera);
      continue;
    }
    throw new ErrorAnthropic(tipo, r.status, tipo === 'limite' ? espera : undefined);
  }
}
