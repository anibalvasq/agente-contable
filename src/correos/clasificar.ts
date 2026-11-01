import type { Empresa } from '../empresas/empresas.js';
import { normalizarTexto } from '../lib/csv.js';
import { normalizarRut } from '../lib/rut.js';
import type { Categoria, ReglasCorreo } from './reglas.js';

/**
 * Clasifica un correo entrante y decide a quién derivarlo, según las reglas
 * configuradas (ver reglas.ts). Es una función pura: no envía ni escribe nada,
 * solo devuelve la decisión y el porqué, para que una persona pueda revisarla.
 */

export interface CorreoEntrante {
  de: string;
  asunto: string;
  cuerpo: string;
}

export interface Persona {
  clave: string;
  nombre: string;
  correo: string;
}

export interface Decision {
  empresa: { id: string; rut: string; nombre: string } | null;
  identificadaPor: 'remitente' | 'dominio' | 'nombre' | null;
  categoria: { id: string; nombre: string } | null;
  /** Otras categorías que también calzaron: sirve para ver si un correo debería ir a más de una persona. */
  tambien: string[];
  /** 'responder_ia' solo si la categoría lo pide; el resolver puede devolverlo a 'derivar'. */
  accion: 'derivar' | 'responder_ia';
  destino: Persona;
  motivo: string;
  /** Cosas que una persona debería mirar. Vacío = decisión sin reparos. */
  dudas: string[];
}

// Dominios que usa cualquiera: el dominio no dice de qué empresa es el correo.
const DOMINIOS_PUBLICOS = new Set(['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.es', 'live.com', 'icloud.com', 'googlemail.com']);
const SUFIJOS_SOCIETARIOS = /\b(ltda|limitada|spa|eirl|s\.?a\.?|sociedad anonima|e\.?i\.?r\.?l\.?)\b\.?/g;

const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** El texto del correo, listo para buscar palabras: sin tildes, minúsculas, espacios simples. */
export const textoDe = (c: CorreoEntrante): string => normalizarTexto(`${c.asunto} ${c.cuerpo}`).replace(/\s+/g, ' ');

/** ¿La palabra (o frase) aparece al inicio de alguna palabra del texto? */
function calza(texto: string, palabra: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapar(normalizarTexto(palabra).replace(/\s+/g, ' '))}`).test(texto);
}

function categoriaCalza(c: Categoria, texto: string): boolean {
  return c.palabras.some((p) => calza(texto, p)) && (!c.ademas.length || c.ademas.some((p) => calza(texto, p)));
}

interface Identificada {
  e: Empresa;
  por: NonNullable<Decision['identificadaPor']>;
  /** Otras empresas que calzaban igual de bien (un grupo que comparte casilla). */
  ambiguaCon: string[];
}

const nombreCorto = (e: Empresa) => normalizarTexto(e.nombre).replace(SUFIJOS_SOCIETARIOS, '').replace(/\s+/g, ' ').trim();

function identificarEmpresa(c: CorreoEntrante, empresas: readonly Empresa[], texto: string): Identificada | null {
  const remitente = normalizarTexto(c.de.match(/<([^>]+)>/)?.[1] ?? c.de);
  const exactas = empresas.filter((e) => e.correos.some((x) => normalizarTexto(x) === remitente));
  if (exactas.length) {
    // Varias empresas pueden compartir casilla: si el texto nombra a una, es esa.
    const nombrada = exactas.filter((e) => nombreCorto(e).length >= 5 && calza(texto, nombreCorto(e)));
    const elegida = nombrada.length === 1 ? nombrada[0]! : exactas[0]!;
    return { e: elegida, por: 'remitente', ambiguaCon: nombrada.length === 1 ? [] : exactas.filter((e) => e !== elegida).map((e) => e.nombre) };
  }

  const dominio = remitente.split('@')[1];
  if (dominio && !DOMINIOS_PUBLICOS.has(dominio)) {
    // Solo si el dominio apunta a UNA empresa: dos empresas que comparten
    // dominio (un grupo) no permiten saber de cuál es el correo.
    const delDominio = empresas.filter((e) => e.correos.some((x) => normalizarTexto(x).endsWith('@' + dominio)));
    if (delDominio.length === 1) return { e: delDominio[0]!, por: 'dominio', ambiguaCon: [] };
  }

  const porNombre = empresas.filter((e) => nombreCorto(e).length >= 5 && calza(texto, nombreCorto(e)));
  return porNombre.length === 1 ? { e: porNombre[0]!, por: 'nombre', ambiguaCon: [] } : null;
}

/** Busca a la persona por clave, nombre o alias ("Matías"). */
function buscarPersona(valor: string, reglas: ReglasCorreo): Persona | null {
  const v = normalizarTexto(valor);
  for (const [clave, m] of Object.entries(reglas.equipo)) {
    if (clave === v || normalizarTexto(m.nombre) === v || m.alias.some((a) => normalizarTexto(a) === v)) {
      return { clave, nombre: m.nombre, correo: m.correo };
    }
  }
  return null;
}

const persona = (clave: string, reglas: ReglasCorreo): Persona => {
  const m = reglas.equipo[clave]!; // validado por reglasSchema: todo destino existe en el equipo
  return { clave, nombre: m.nombre, correo: m.correo };
};

export function clasificar(correo: CorreoEntrante, empresas: readonly Empresa[], reglas: ReglasCorreo): Decision {
  const texto = textoDe(correo);
  const id = identificarEmpresa(correo, empresas, texto);
  const empresa = id?.e ?? null;
  const rut = empresa && normalizarRut(empresa.rut)?.rut;
  const cliente = rut ? Object.entries(reglas.clientes).find(([k]) => normalizarRut(k)?.rut === rut)?.[1] : undefined;

  const candidatas = [...reglas.categorias, ...(cliente?.categorias ?? [])]
    .filter((c) => categoriaCalza(c, texto))
    .sort((a, b) => a.prioridad - b.prioridad);
  const cat = candidatas[0];

  const dudas: string[] = [];
  if (!empresa) dudas.push('No se pudo identificar la empresa del correo.');
  if (id?.ambiguaCon.length) dudas.push(`El remitente también es contacto de: ${id.ambiguaCon.join(', ')}. Se asumió ${empresa?.nombre}.`);

  // Quién lleva esta empresa: la excepción del cliente manda sobre la base.
  let encargado: Persona | null = null;
  if (cliente?.encargado) encargado = persona(cliente.encargado, reglas);
  else if (empresa?.encargado) {
    encargado = buscarPersona(empresa.encargado, reglas);
    if (!encargado) dudas.push(`El encargado "${empresa.encargado}" de la base no está en el equipo de las reglas.`);
  }

  let destino: Persona;
  let motivo: string;
  if (cat && (cat.gana_sobre_encargado || !encargado)) {
    destino = persona(cliente?.destinos[cat.id] ?? cat.destino, reglas);
    motivo = `Categoría "${cat.nombre}"${cat.gana_sobre_encargado ? ': gana sobre el encargado' : ''}`;
  } else if (cat && encargado) {
    destino = encargado;
    motivo = `Categoría "${cat.nombre}", pero esta categoría va al encargado de la empresa`;
  } else if (cliente?.sin_categoria) {
    destino = persona(cliente.sin_categoria, reglas);
    motivo = 'Sin categoría: esta empresa tiene un destino propio para lo que no calza';
  } else if (encargado) {
    destino = encargado;
    motivo = 'Sin categoría: dudas y documentos van al encargado de la empresa';
  } else {
    destino = persona(reglas.fallback, reglas);
    motivo = `Sin categoría ni encargado: va a ${destino.nombre}, que lo deriva`;
  }

  if (cat?.id === 'impuestos' && /\?/.test(correo.asunto + correo.cuerpo)) {
    dudas.push('Parece una pregunta: ¿es un trámite de impuestos o una consulta sobre impuestos?');
  }
  if (candidatas.length > 1) dudas.push(`También calza con: ${candidatas.slice(1).map((c) => c.nombre).join(', ')}.`);

  return {
    empresa: empresa ? { id: empresa.id, rut: empresa.rut, nombre: empresa.nombre } : null,
    identificadaPor: id?.por ?? null,
    categoria: cat ? { id: cat.id, nombre: cat.nombre } : null,
    tambien: candidatas.slice(1).map((c) => c.id),
    accion: cat?.resuelve_ia ? 'responder_ia' : 'derivar',
    destino,
    motivo,
    dudas,
  };
}
