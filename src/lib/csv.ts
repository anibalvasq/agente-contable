/**
 * Lector de CSV mínimo para las planillas del estudio (exportadas desde Excel).
 *
 * No usamos una librería porque el caso es chico, pero hay dos trampas reales:
 * Excel en español exporta con ';' (la coma es el separador decimal), y las
 * celdas con comas o saltos de línea vienen entre comillas.
 */

/** Minúsculas y sin tildes: 'Razón Social ' → 'razon social'. */
export function normalizarTexto(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

function detectarSeparador(primeraLinea: string): string {
  const cuentas = [';', ',', '\t'].map((s) => [s, primeraLinea.split(s).length - 1] as const);
  cuentas.sort((a, b) => b[1] - a[1]);
  return cuentas[0]![1] > 0 ? cuentas[0]![0] : ',';
}

export function parseCsv(texto: string): string[][] {
  const t = texto.replace(/^﻿/, ''); // BOM que agrega Excel
  const sep = detectarSeparador(t.split(/\r?\n/, 1)[0] ?? '');
  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = '';
  let entreComillas = false;

  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (entreComillas) {
      if (c === '"' && t[i + 1] === '"') {
        celda += '"';
        i++;
      } else if (c === '"') entreComillas = false;
      else celda += c;
    } else if (c === '"') entreComillas = true;
    else if (c === sep) {
      fila.push(celda);
      celda = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda);
      celda = '';
      filas.push(fila);
      fila = [];
    } else celda += c;
  }
  if (celda !== '' || fila.length) {
    fila.push(celda);
    filas.push(fila);
  }
  return filas.filter((f) => f.some((x) => x.trim() !== ''));
}

export type FilaCsv = Record<string, string>;

/** Filas como objetos, con los encabezados normalizados (minúsculas, sin tildes). */
export function filasComoObjetos(texto: string): FilaCsv[] {
  const [encabezado, ...resto] = parseCsv(texto);
  if (!encabezado) return [];
  const claves = encabezado.map(normalizarTexto);
  return resto.map((f) => Object.fromEntries(claves.map((k, i) => [k, (f[i] ?? '').trim()])));
}
