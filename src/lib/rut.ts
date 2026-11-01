/**
 * RUT chileno: normalización y dígito verificador (módulo 11).
 *
 * La base de empresas llega desde planillas donde el mismo RUT aparece como
 * "76.123.456-7", "76123456-7" o "761234567". Si no se normaliza, la misma
 * empresa queda duplicada y los contactos no cruzan con las hojas F29/Previred.
 */

/** Dígito verificador de un RUT sin DV (solo el cuerpo numérico). */
export function dvRut(cuerpo: number | string): string {
  let suma = 0;
  let mult = 2;
  for (const d of String(cuerpo).split('').reverse()) {
    suma += Number(d) * mult;
    mult = mult === 7 ? 2 : mult + 1;
  }
  const r = 11 - (suma % 11);
  return r === 11 ? '0' : r === 10 ? 'K' : String(r);
}

export interface RutNormalizado {
  /** 'CUERPO-DV', sin puntos y con K mayúscula. */
  rut: string;
  /** false si el DV no corresponde al cuerpo: casi siempre un error de tipeo. */
  valido: boolean;
}

/** null si el texto ni siquiera tiene forma de RUT. */
export function normalizarRut(raw: string): RutNormalizado | null {
  const limpio = raw.replace(/[.\s]/g, '').toUpperCase();
  const m = /^(\d{1,9})-?([0-9K])$/.exec(limpio);
  if (!m) return null;
  const cuerpo = String(Number(m[1])); // quita ceros a la izquierda
  const dv = m[2]!;
  return { rut: `${cuerpo}-${dv}`, valido: dvRut(cuerpo) === dv };
}
