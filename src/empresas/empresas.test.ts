import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filasComoObjetos } from '../lib/csv.js';
import { dvRut, normalizarRut } from '../lib/rut.js';
import { armarEmpresas } from './empresas.js';

describe('rut', () => {
  it('calcula el dígito verificador', () => {
    assert.equal(dvRut(76123456), '0');
    assert.equal(dvRut(12345678), '5');
    assert.equal(dvRut(10000013), 'K');
  });
  it('normaliza formatos y detecta DV malo', () => {
    assert.deepEqual(normalizarRut('76.123.456-0'), { rut: '76123456-0', valido: true });
    assert.deepEqual(normalizarRut('761234560'), { rut: '76123456-0', valido: true });
    assert.deepEqual(normalizarRut('10.000.013-k'), { rut: '10000013-K', valido: true });
    assert.equal(normalizarRut('76.123.456-1')?.valido, false);
    assert.equal(normalizarRut('hola'), null);
  });
});

describe('csv', () => {
  it('lee ; de Excel, comillas y BOM', () => {
    const f = filasComoObjetos('﻿RUT;Razón Social;Nota\r\n76123456-0;"Pérez; y Cía";"dice ""hola"""\r\n');
    assert.deepEqual(f, [{ rut: '76123456-0', 'razon social': 'Pérez; y Cía', nota: 'dice "hola"' }]);
  });
});

const F29 = `RUT;Nombre;Encargado;Remuneraciones;Clave
76.123.456-0;Aromos Ltda.;Claudia;Sí;SecretoUno
12.345.678-5;Pérez SpA;;No;SecretoDos
11.111.111-9;RUT malo SpA;Javier;No;x
`;
const PREVIRED = `RUT;Nombre;Responsable
76123456-0;Aromos Ltda.;Claudia
`;
const CONTACTOS = `RUT;Contacto principal;Correo 1;Correo 2
76123456-0;Ana;ana@aromos.cl;ANA2@aromos.cl; extra@aromos.cl
99999999-9;Otra empresa;otra@x.cl;
`;

describe('armarEmpresas', () => {
  const r = armarEmpresas({ f29: F29, previred: PREVIRED, contactos: CONTACTOS });
  const por = (rut: string) => r.empresas.find((e) => e.rut === rut)!;

  it('cruza las tres planillas por RUT', () => {
    assert.equal(r.empresas.length, 3);
    const a = por('76123456-0');
    assert.deepEqual([a.f29, a.previred, a.remuneraciones, a.encargado], [true, true, true, 'Claudia']);
    assert.deepEqual(a.correos, ['ana@aromos.cl', 'ana2@aromos.cl']);
  });

  it('no deja pasar una clave a la base', () => {
    assert.ok(!JSON.stringify(r.empresas).includes('Secreto'));
  });

  it('avisa lo que hay que revisar', () => {
    const t = r.avisos.join('\n');
    assert.match(t, /Pérez SpA.*no está en el archivo de contactos/);
    assert.match(t, /11111111-9.*dígito verificador/);
    assert.doesNotMatch(t, /99999999/); // solo en contactos: se ignora
  });
});
