import { periodoAnterior, vencimientosF29 } from '../agent/tools/chile/calc.js';

/**
 * Fechas del motor de recordatorios. Todo en 'YYYY-MM-DD' y sobre UTC, para que
 * el huso del servidor no corra un día.
 *
 * El F29 NO se recalcula aquí: se toma de `vencimientosF29` (la misma lógica que
 * usa la herramienta `consultar_vencimientos`), para que el agente y los
 * recordatorios nunca digan fechas distintas. Esa función ya corre sábado y
 * domingo al lunes; este módulo suma los feriados, que ella no conoce.
 */

export type Obligacion = 'previred' | 'f29';
export type ModoAviso = 'habiles' | 'corridos';

const aMs = (iso: string) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const aIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DIA = 86_400_000;

export const sumarDias = (iso: string, n: number): string => aIso(aMs(iso) + n * DIA);

export function esHabil(iso: string, feriados: ReadonlySet<string> = new Set()): boolean {
  const dow = new Date(aMs(iso)).getUTCDay();
  return dow !== 0 && dow !== 6 && !feriados.has(iso);
}

export function siguienteHabil(iso: string, feriados?: ReadonlySet<string>): string {
  let f = iso;
  while (!esHabil(f, feriados)) f = sumarDias(f, 1);
  return f;
}

/** Retrocede `n` días hábiles (el 0 devuelve la misma fecha). */
function habilesAntes(iso: string, n: number, feriados?: ReadonlySet<string>): string {
  let f = iso;
  for (let i = 0; i < n; ) {
    f = sumarDias(f, -1);
    if (esHabil(f, feriados)) i++;
  }
  return f;
}

/**
 * Vencimiento de Previred del mes `mes` ('AAAA-MM'): día 13, o el siguiente día
 * hábil si cae en fin de semana o feriado. (La regla del corrimiento figura
 * como "por definir" en el Flujorama; se aplica la misma que usa el SII para el F29.)
 */
export function vencimientoPrevired(mes: string, feriados?: ReadonlySet<string>): string {
  return siguienteHabil(`${mes}-13`, feriados);
}

/**
 * Vencimiento del F29 que se paga en `mes`: el del período anterior, "por
 * internet con pago" (día 20), que es el que aplica a quienes declaran con pago.
 */
export function vencimientoF29(mes: string, hoy: string, feriados?: ReadonlySet<string>): string {
  const periodo = periodoAnterior(`${mes}-01`);
  const v = vencimientosF29(periodo, hoy).find((x) => x.caso.includes('día 20'));
  if (!v) throw new Error('vencimientosF29 ya no devuelve el plazo del día 20');
  return siguienteHabil(v.fecha, feriados);
}

export function vencimientoDe(tipo: Obligacion, mes: string, hoy: string, feriados?: ReadonlySet<string>): string {
  return tipo === 'previred' ? vencimientoPrevired(mes, feriados) : vencimientoF29(mes, hoy, feriados);
}

/**
 * Fecha de cada recordatorio. Con 'habiles' (por defecto) "dos y un día antes"
 * son los dos y un día HÁBIL antes: no sale ningún correo en fin de semana ni
 * feriado. Con 'corridos' es literal (Previred el 13 → días 11 y 12).
 */
export function fechasAviso(
  vencimiento: string,
  diasAntes: readonly number[],
  modo: ModoAviso,
  feriados?: ReadonlySet<string>,
): Array<{ diasAntes: number; fecha: string }> {
  return diasAntes.map((n) => ({
    diasAntes: n,
    fecha: modo === 'habiles' ? habilesAntes(vencimiento, n, feriados) : sumarDias(vencimiento, -n),
  }));
}
