/**
 * Cálculos tributarios de Chile, en funciones puras. Viven aparte de las
 * herramientas para poder probarlos sin el modelo: las cuentas las hace el
 * código, nunca el LLM, porque un modelo que "calcula de cabeza" se equivoca en
 * silencio y el cliente declara con ese número.
 *
 * Todo en pesos chilenos enteros (CLP no tiene decimales).
 */

export const IVA_PCT = 19;

/**
 * Retención de boletas de honorarios por año (Ley 21.133, gradual).
 * Verificado en sii.cl/destacados/boletas_honorarios: 14,5% en 2025, 15,25% en
 * 2026, 16% en 2027 y 17% desde 2028. Antes de 2025 no se soporta a propósito:
 * no queremos calcular con una tasa de memoria.
 */
const RETENCION_HONORARIOS_PCT: Record<number, number> = { 2025: 14.5, 2026: 15.25, 2027: 16, 2028: 17 };

export function retencionHonorariosPct(year: number): number | undefined {
  if (year > 2028) return 17; // 2028 es el último escalón de la ley.
  return RETENCION_HONORARIOS_PCT[year];
}

export interface Iva {
  neto: number;
  iva: number;
  bruto: number;
  tasaPct: number;
}

/** `base` dice qué es el monto recibido: el neto (sin IVA) o el bruto (con IVA). */
export function calcularIva(monto: number, base: 'neto' | 'bruto', tasaPct = IVA_PCT): Iva {
  if (base === 'neto') {
    const neto = Math.round(monto);
    const iva = Math.round((neto * tasaPct) / 100);
    return { neto, iva, bruto: neto + iva, tasaPct };
  }
  const bruto = Math.round(monto);
  const neto = Math.round(bruto / (1 + tasaPct / 100));
  return { neto, iva: bruto - neto, bruto, tasaPct };
}

export interface Honorarios {
  bruto: number;
  retencion: number;
  liquido: number;
  tasaPct: number;
}

/**
 * `base` dice qué es el monto recibido: el bruto de la boleta, o el líquido que
 * se quiere recibir (en ese caso se calcula el bruto a emitir).
 */
export function calcularHonorarios(monto: number, base: 'bruto' | 'liquido', tasaPct: number): Honorarios {
  const bruto = base === 'bruto' ? Math.round(monto) : Math.round(monto / (1 - tasaPct / 100));
  const retencion = Math.round((bruto * tasaPct) / 100);
  return { bruto, retencion, liquido: bruto - retencion, tasaPct };
}

/** PPM = ventas netas del mes × tasa. La tasa la define el régimen y la última declaración. */
export function calcularPpm(ventasNetas: number, tasaPct: number): { ventasNetas: number; tasaPct: number; ppm: number } {
  const neto = Math.round(ventasNetas);
  return { ventasNetas: neto, tasaPct, ppm: Math.round((neto * tasaPct) / 100) };
}

// ── Fechas ──────────────────────────────────────────────────────

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Hoy en Chile como 'YYYY-MM-DD'. El server puede estar en UTC y ser "mañana" allá. */
export function hoyChile(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(now);
}

function utc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Un sábado o domingo pasa al lunes. Los feriados NO se consideran (ver vencimientosF29). */
function proximoHabil(d: Date): Date {
  const out = new Date(d);
  while (out.getUTCDay() === 0 || out.getUTCDay() === 6) out.setUTCDate(out.getUTCDate() + 1);
  return out;
}

/** El período tributario anterior al mes de `hoy`, como 'YYYY-MM'. */
export function periodoAnterior(hoy: string): string {
  const d = utc(hoy);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return iso(d).slice(0, 7);
}

export interface Vencimiento {
  caso: string;
  fecha: string;
  diaSemana: string;
  diasRestantes: number;
}

/**
 * Plazos del F29 de un período (verificado en sii.cl, "Plazos para presentar el
 * Formulario 29"): día 12 del mes siguiente; día 20 si se declara por internet
 * CON pago (facturadores electrónicos y emisores de boleta de honorarios
 * electrónica); día 28 si se declara por internet SIN pago. Si cae en sábado o
 * domingo se corre al siguiente día hábil.
 *
 * Los feriados no están modelados: dependen del año (Semana Santa, etc.), así
 * que un plazo que caiga en feriado puede correrse un día más.
 */
export function vencimientosF29(periodo: string, hoy: string): Vencimiento[] {
  const [y, m] = periodo.split('-').map(Number) as [number, number];
  const base = new Date(Date.UTC(y, m, 1)); // mes siguiente (m es 1-based → índice del siguiente)
  const casos: Array<[string, number]> = [
    ['F29 presentación general (día 12)', 12],
    ['F29 por internet con pago (día 20)', 20],
    ['F29 por internet sin pago (día 28)', 28],
  ];
  const hoyMs = utc(hoy).getTime();
  return casos.map(([caso, dia]) => {
    const f = proximoHabil(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), dia)));
    return {
      caso,
      fecha: iso(f),
      diaSemana: DIAS[f.getUTCDay()]!,
      diasRestantes: Math.round((f.getTime() - hoyMs) / 86_400_000),
    };
  });
}
