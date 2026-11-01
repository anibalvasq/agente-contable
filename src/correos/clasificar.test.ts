import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import type { Empresa } from '../empresas/empresas.js';
import { clasificar } from './clasificar.js';
import { procesarCorreo } from './procesar.js';
import { validarReglas, type ReglasCorreo } from './reglas.js';

async function reglasDeEjemplo(extra?: Partial<ReglasCorreo>): Promise<ReglasCorreo> {
  const v = validarReglas({ ...parse(await readFile('config/correo-reglas.yaml', 'utf8')), ...extra });
  assert.ok(v.ok, v.ok ? '' : v.errores.join('; '));
  return v.reglas;
}

const emp = (o: Partial<Empresa>): Empresa => ({
  id: 'emp_x', rut: '76123456-7', rutValido: true, nombre: 'Transportes Andes Sur Ltda.', encargado: 'Javier',
  f29: true, previred: true, remuneraciones: true, correos: ['finanzas@andessur.cl'], ...o,
});
const EMPRESAS = [
  emp({}),
  emp({ id: 'emp_2', rut: '12345678-5', nombre: 'Panadería San Camilo EIRL', encargado: null, correos: ['sancamilo@gmail.com'] }),
  emp({ id: 'emp_3', rut: '10000013-K', nombre: 'Clínica Dental Sonrisa SpA', encargado: 'Matías', correos: ['contacto@sonrisa.cl'] }),
];
const c = (de: string, asunto: string, cuerpo = '') => ({ de, asunto, cuerpo });

describe('reglas de ejemplo', () => {
  it('el archivo de ejemplo es válido', async () => {
    await reglasDeEjemplo();
  });
  it('rechaza un destino que no está en el equipo', () => {
    const v = validarReglas({ equipo: { a: { nombre: 'A', correo: 'a@x.cl' } }, fallback: 'b', categorias: [] });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.errores.join(), /"b" no está en el equipo/);
  });
});

describe('clasificar', () => {
  it('la categoría gana sobre el encargado', async () => {
    const d = clasificar(c('finanzas@andessur.cl', 'Liquidaciones de sueldo', 'horas extra de octubre'), EMPRESAS, await reglasDeEjemplo());
    assert.equal(d.categoria?.id, 'remuneraciones');
    assert.equal(d.destino.clave, 'aquiles'); // la empresa es de Javier, pero la categoría gana
    assert.equal(d.empresa?.nombre, 'Transportes Andes Sur Ltda.');
    assert.equal(d.identificadaPor, 'remitente');
  });

  it('la regla más específica gana: transferencia de remuneraciones no es "otras transferencias"', async () => {
    const r = await reglasDeEjemplo();
    assert.equal(clasificar(c('x@y.cl', 'Comprobante', 'transferencia de remuneraciones de octubre'), EMPRESAS, r).destino.clave, 'aquiles');
    assert.equal(clasificar(c('x@y.cl', 'Comprobante', 'transferencia a proveedor'), EMPRESAS, r).destino.clave, 'yenifer');
  });

  it('consulta sobre impuestos va a G. Vergara y un trámite de impuestos a Aquiles', async () => {
    const r = await reglasDeEjemplo();
    assert.equal(clasificar(c('x@y.cl', 'Duda', '¿el IVA de aduana es crédito fiscal?'), EMPRESAS, r).destino.clave, 'gvergara');
    const tramite = clasificar(c('x@y.cl', 'F29 de octubre', 'Les envío el F29 firmado?'), EMPRESAS, r);
    assert.equal(tramite.destino.clave, 'aquiles');
    assert.ok(tramite.dudas.some((d) => /consulta sobre impuestos/.test(d)));
  });

  it('las palabras calzan al inicio de palabra: "motivación" no es IVA', async () => {
    const d = clasificar(c('x@y.cl', 'Gracias', 'Nos dio mucha motivación su ayuda'), EMPRESAS, await reglasDeEjemplo());
    assert.equal(d.categoria, null);
  });

  it('sin categoría va al encargado; sin encargado, a Aquiles', async () => {
    const r = await reglasDeEjemplo();
    assert.equal(clasificar(c('finanzas@andessur.cl', 'Cartola banco', 'adjunto'), EMPRESAS, r).destino.clave, 'javier');
    const sin = clasificar(c('sancamilo@gmail.com', 'Documentos', 'boletas'), EMPRESAS, r);
    assert.equal(sin.destino.clave, 'aquiles');
    assert.equal(sin.empresa?.nombre, 'Panadería San Camilo EIRL');
  });

  it('un encargado de la base que no está en el equipo (Matías) se marca, no se pierde', async () => {
    const d = clasificar(c('contacto@sonrisa.cl', 'Cartola', 'adjunto'), EMPRESAS, await reglasDeEjemplo());
    assert.equal(d.destino.clave, 'aquiles');
    assert.ok(d.dudas.some((x) => /Matías/.test(x)));
  });

  it('con el alias configurado, Matías llega a Yenifer', async () => {
    const base = await reglasDeEjemplo();
    const r = await reglasDeEjemplo({ equipo: { ...base.equipo, yenifer: { ...base.equipo.yenifer!, alias: ['matias'] } } });
    assert.equal(clasificar(c('contacto@sonrisa.cl', 'Cartola', 'adjunto'), EMPRESAS, r).destino.clave, 'yenifer');
  });

  it('una excepción por cliente cambia el destino de lo que no calza', async () => {
    const r = await reglasDeEjemplo({ clientes: { '76123456-7': { encargado: 'yahel', destinos: {}, categorias: [] } } });
    assert.equal(clasificar(c('finanzas@andessur.cl', 'Facturas de compra', 'adjunto'), EMPRESAS, r).destino.clave, 'yahel');
    assert.equal(clasificar(c('finanzas@andessur.cl', 'Finiquito', 'calcular'), EMPRESAS, r).destino.clave, 'aquiles');
  });

  it('un remitente desconocido va a Aquiles y deja la duda', async () => {
    const d = clasificar(c('nadie@gmail.com', 'Información', '¿llevan contabilidad de pymes?'), EMPRESAS, await reglasDeEjemplo());
    assert.equal(d.empresa, null);
    assert.equal(d.destino.clave, 'aquiles');
    assert.ok(d.dudas.some((x) => /identificar la empresa/.test(x)));
  });
});

describe('consultas simples (IA)', () => {
  const correo = c('finanzas@andessur.cl', 'Fecha', '¿Cuándo vence el F29 de este mes?');

  it('con resolver, queda un borrador y nada se envía', async () => {
    const r = await procesarCorreo(correo, EMPRESAS, await reglasDeEjemplo(), async () => 'Vence el 20.');
    assert.equal(r.accion, 'responder_ia');
    assert.equal(r.borrador, 'Vence el 20.');
  });

  it('si la IA no puede, se deriva a una persona', async () => {
    const r = await procesarCorreo(correo, EMPRESAS, await reglasDeEjemplo(), async () => null);
    assert.equal(r.accion, 'derivar');
    assert.equal(r.borrador, null);
    assert.equal(r.destino.clave, 'aquiles');
  });

  it('si el modelo falla, se deriva en vez de perder el correo', async () => {
    const r = await procesarCorreo(correo, EMPRESAS, await reglasDeEjemplo(), async () => { throw new Error('timeout'); });
    assert.equal(r.accion, 'derivar');
  });

  it('con la IA apagada (sin resolver) se deriva', async () => {
    const r = await procesarCorreo(correo, EMPRESAS, await reglasDeEjemplo());
    assert.equal(r.accion, 'derivar');
  });
});
