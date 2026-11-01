import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { PanelStore } from '../panel/store.js';

/**
 * Reglas de clasificación y derivación de correos (proceso 5).
 *
 * Son DATOS, no código: el estudio las edita desde el panel (colección
 * `reglas`, documento `reg_correo`) o, mientras no haya ninguna guardada, se
 * usan las de config/correo-reglas.yaml. Una regla mal escrita se rechaza al
 * guardar (ver validación en panel/routes.ts), no a mitad de un correo real.
 *
 * Las palabras NO son expresiones regulares a propósito: las edita personal no
 * técnico y una regex mal puesta puede colgar el servidor. Cada palabra calza
 * al inicio de una palabra del correo ("finiquit" calza "finiquito" pero "iva"
 * no calza "motivación").
 */

const clave = z.string().regex(/^[a-z0-9_]+$/, 'solo minúsculas, números y guion bajo');

export const categoriaSchema = z.object({
  id: clave,
  nombre: z.string().min(1),
  /** Clave de una persona de `equipo`. */
  destino: clave,
  /** El correo calza si trae AL MENOS UNA de estas palabras… */
  palabras: z.array(z.string().min(2)).min(1),
  /** …y, si hay lista, AL MENOS UNA de estas también (distingue "consulta sobre impuestos" de "impuestos"). */
  ademas: z.array(z.string().min(2)).default([]),
  /** Menor número = se evalúa antes. Las específicas van antes que las generales. */
  prioridad: z.number().int().default(100),
  /** true: va al destino aunque la empresa tenga otro encargado. */
  gana_sobre_encargado: z.boolean().default(true),
  /** true: la IA intenta responder (queda como borrador); si no puede, se deriva. */
  resuelve_ia: z.boolean().default(false),
});
export type Categoria = z.infer<typeof categoriaSchema>;

const miembroSchema = z.object({
  nombre: z.string().min(1),
  correo: z.string().email(),
  /** Otros nombres con que aparece en la base de empresas ("Matías" → Yenifer, si el estudio así lo decide). */
  alias: z.array(z.string()).default([]),
});

const clienteSchema = z.object({
  /** Reemplaza al encargado de la base para esta empresa. */
  encargado: clave.optional(),
  /** A quién va un correo sin categoría. Por defecto, el encargado. */
  sin_categoria: clave.optional(),
  /** Categoría → persona, solo para esta empresa (p. ej. remuneraciones de Gastronómica → Aquiles). */
  destinos: z.record(clave).default({}),
  /** Categorías que solo existen para este cliente (p. ej. "contabilidad" → Yahel). */
  categorias: z.array(categoriaSchema).default([]),
});
export type ReglasCliente = z.infer<typeof clienteSchema>;

export const reglasSchema = z
  .object({
    equipo: z.record(clave, miembroSchema),
    /** Quien recibe lo que no tiene categoría ni encargado, y lo deriva a mano. */
    fallback: clave,
    categorias: z.array(categoriaSchema),
    /** Excepciones por cliente, por RUT ('76123456-7'). */
    clientes: z.record(clienteSchema).default({}),
  })
  .superRefine((r, ctx) => {
    const personas = new Set(Object.keys(r.equipo));
    const falta = (valor: string, ruta: (string | number)[]) => {
      if (!personas.has(valor)) ctx.addIssue({ code: 'custom', path: ruta, message: `"${valor}" no está en el equipo` });
    };
    falta(r.fallback, ['fallback']);
    r.categorias.forEach((c, i) => falta(c.destino, ['categorias', i, 'destino']));
    for (const [rut, c] of Object.entries(r.clientes)) {
      if (c.encargado) falta(c.encargado, ['clientes', rut, 'encargado']);
      if (c.sin_categoria) falta(c.sin_categoria, ['clientes', rut, 'sin_categoria']);
      Object.entries(c.destinos).forEach(([cat, p]) => falta(p, ['clientes', rut, 'destinos', cat]));
      c.categorias.forEach((cat, i) => falta(cat.destino, ['clientes', rut, 'categorias', i, 'destino']));
    }
  });
export type ReglasCorreo = z.infer<typeof reglasSchema>;

export const ID_DOC_REGLAS = 'reg_correo';
const ARCHIVO = path.resolve(process.cwd(), 'config', 'correo-reglas.yaml');

export function validarReglas(datos: unknown): { ok: true; reglas: ReglasCorreo } | { ok: false; errores: string[] } {
  const r = reglasSchema.safeParse(datos);
  if (r.success) return { ok: true, reglas: r.data };
  return { ok: false, errores: r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`) };
}

/** Las reglas guardadas en el panel; si no hay, las del archivo de ejemplo. */
export async function cargarReglas(store: PanelStore): Promise<{ reglas: ReglasCorreo; origen: 'panel' | 'archivo' }> {
  const guardada = (await store.list('reglas')).find((d) => (d as { id?: unknown }).id === ID_DOC_REGLAS);
  const origen = guardada ? 'panel' : 'archivo';
  const datos = guardada ?? parse(await readFile(ARCHIVO, 'utf8'));
  const v = validarReglas(datos);
  if (!v.ok) throw new Error(`Las reglas de correo (${origen}) no son válidas: ${v.errores.join('; ')}`);
  return { reglas: v.reglas, origen };
}
