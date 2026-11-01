import { filasComoObjetos, normalizarTexto, type FilaCsv } from '../lib/csv.js';
import { normalizarRut } from '../lib/rut.js';

/**
 * Base de empresas del estudio. Se arma con tres planillas que ya existen:
 * la hoja F29, la hoja Previred y el archivo de contactos. Vive en la colección
 * `empresas` del panel, así se corrige desde ahí sin tocar código.
 *
 * Las claves NO pasan por aquí: la hoja F29 trae una columna de claves en texto
 * simple y este módulo no la lee. Van a la bóveda (src/credentials/vault.ts).
 */

export interface Empresa {
  /** 'emp_' + RUT sin guion, apto para el almacén del panel (ver ID_VALIDO en panel/routes.ts). */
  id: string;
  rut: string;
  /** false si el dígito verificador no calza: se importa igual, pero se avisa. */
  rutValido: boolean;
  nombre: string;
  /** Tal como viene en la hoja ("Claudia", "Matías"…). El mapeo a persona lo hace correos/clasificar. */
  encargado: string | null;
  f29: boolean;
  previred: boolean;
  remuneraciones: boolean;
  /** Hasta dos correos, el principal y el secundario. */
  correos: string[];
}

export const empresaId = (rut: string): string => 'emp_' + rut.replace('-', '').toLowerCase();

const EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;

/** Primera columna cuyo encabezado contiene alguno de los fragmentos. */
function col(fila: FilaCsv, ...fragmentos: string[]): string {
  const k = Object.keys(fila).find((h) => fragmentos.some((f) => h.includes(f)));
  return k ? (fila[k] ?? '') : '';
}

const afirmativo = (v: string): boolean => ['si', 'x', '1', 'true', 'yes'].includes(normalizarTexto(v));

function correosDe(fila: FilaCsv): string[] {
  const out: string[] = [];
  for (const [h, v] of Object.entries(fila)) {
    if (!/(correo|mail)/.test(h)) continue;
    for (const c of v.split(/[\s;,]+/)) {
      const limpio = c.trim().toLowerCase();
      if (EMAIL.test(limpio) && !out.includes(limpio)) out.push(limpio);
    }
  }
  return out.slice(0, 2);
}

export interface ResultadoImportacion {
  empresas: Empresa[];
  /** Cosas que la persona del estudio debe mirar antes de confiar en la base. */
  avisos: string[];
}

export interface Planillas {
  f29: string;
  previred: string;
  contactos: string;
}

export function armarEmpresas(planillas: Planillas): ResultadoImportacion {
  const avisos: string[] = [];
  const porRut = new Map<string, Empresa>();

  const asegurar = (fila: FilaCsv, origen: string): Empresa | null => {
    const r = normalizarRut(col(fila, 'rut'));
    if (!r) {
      avisos.push(`${origen}: fila sin RUT válido (${col(fila, 'nombre', 'razon', 'empresa') || 'sin nombre'}).`);
      return null;
    }
    let e = porRut.get(r.rut);
    if (!e) {
      e = {
        id: empresaId(r.rut),
        rut: r.rut,
        rutValido: r.valido,
        nombre: col(fila, 'razon', 'nombre', 'empresa'),
        encargado: null,
        f29: false,
        previred: false,
        remuneraciones: false,
        correos: [],
      };
      porRut.set(r.rut, e);
      if (!r.valido) avisos.push(`${origen}: el RUT ${r.rut} tiene el dígito verificador incorrecto.`);
    }
    if (!e.nombre) e.nombre = col(fila, 'razon', 'nombre', 'empresa');
    e.encargado ||= col(fila, 'encargad', 'responsable') || null;
    return e;
  };

  for (const f of filasComoObjetos(planillas.f29)) {
    const e = asegurar(f, 'Hoja F29');
    if (!e) continue;
    e.f29 = true;
    e.remuneraciones ||= afirmativo(col(f, 'remuneracion'));
  }
  for (const f of filasComoObjetos(planillas.previred)) {
    const e = asegurar(f, 'Hoja Previred');
    if (e) e.previred = true;
  }

  // Los contactos solo completan empresas que ya están en F29 o Previred: una
  // empresa que figura únicamente en contactos no debe recibir recordatorios.
  const conContacto = new Set<string>();
  for (const f of filasComoObjetos(planillas.contactos)) {
    const r = normalizarRut(col(f, 'rut'));
    const e = r && porRut.get(r.rut);
    if (!e) continue;
    e.correos = correosDe(f);
    conContacto.add(e.rut);
  }

  for (const e of porRut.values()) {
    if (!conContacto.has(e.rut)) avisos.push(`${e.nombre || e.rut} (${e.rut}) no está en el archivo de contactos.`);
    else if (!e.correos.length) avisos.push(`${e.nombre || e.rut} (${e.rut}) está en contactos pero sin correo.`);
    if (e.remuneraciones && !e.previred) avisos.push(`${e.nombre || e.rut} (${e.rut}) lleva remuneraciones pero no está en la hoja Previred.`);
  }

  return { empresas: [...porRut.values()], avisos };
}
