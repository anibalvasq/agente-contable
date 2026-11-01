import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Empresa } from '../empresas/empresas.js';
import { vencimientoF29, vencimientoPrevired, fechasAviso } from './calendario.js';
import { armarPlan, planACsv } from './plan.js';

const emp = (o: Partial<Empresa>): Empresa => ({
  id: 'emp_1', rut: '76123456-7', rutValido: true, nombre: 'Aromos', encargado: 'Claudia',
  f29: true, previred: false, remuneraciones: false, correos: ['a@x.cl', 'b@x.cl'], ...o,
});

describe('vencimientos', () => {
  it('Previred el 13 y F29 el 20 cuando son días hábiles', () => {
    assert.equal(vencimientoPrevired('2026-11', new Set()), '2026-11-13'); // viernes
    assert.equal(vencimientoF29('2026-11', '2026-11-01'), '2026-11-20'); // viernes
  });
  it('corre al siguiente día hábil si cae en fin de semana', () => {
    assert.equal(vencimientoPrevired('2026-12', new Set()), '2026-12-14'); // 13 = domingo
    assert.equal(vencimientoF29('2026-12', '2026-12-01'), '2026-12-21'); // 20 = domingo
  });
  it('corre por feriado cuando se le informa', () => {
    assert.equal(vencimientoPrevired('2026-11', new Set(['2026-11-13'])), '2026-11-16');
  });
  it('el F29 sale de la misma función que la herramienta consultar_vencimientos', async () => {
    const { consultarVencimientosTool } = await import('../agent/tools/chile/tools.js');
    const r = (await consultarVencimientosTool.run({ periodo: '2026-10' }, {} as never)) as { vencimientos: Array<{ caso: string; fecha: string }> };
    assert.equal(r.vencimientos.find((v) => v.caso.includes('día 20'))?.fecha, vencimientoF29('2026-11', '2026-11-01'));
  });
});

describe('fechas de aviso', () => {
  it('"2 y 1 día antes" en días hábiles no cae en fin de semana', () => {
    // Vence lunes 14-dic-2026: los avisos son jueves 10 y viernes 11, no sábado/domingo.
    assert.deepEqual(fechasAviso('2026-12-14', [2, 1], 'habiles').map((x) => x.fecha), ['2026-12-10', '2026-12-11']);
  });
  it('en días corridos es literal', () => {
    assert.deepEqual(fechasAviso('2026-12-14', [2, 1], 'corridos').map((x) => x.fecha), ['2026-12-12', '2026-12-13']);
  });
});

describe('plan del mes', () => {
  const empresas = [
    emp({ id: 'emp_1', nombre: 'Aromos', f29: true, previred: true }),
    emp({ id: 'emp_2', rut: '12345678-5', nombre: 'Sin correo', correos: [], encargado: null }),
    emp({ id: 'emp_3', rut: '11111111-9', nombre: 'RUT malo', rutValido: false, f29: false, previred: false }),
  ];
  const plan = armarPlan(empresas, { mes: '2026-11', hoy: '2026-11-01', feriados: new Set() });

  it('cada empresa recibe dos avisos por obligación que paga', () => {
    const de = (id: string) => plan.recordatorios.filter((r) => r.empresaId === id);
    assert.equal(de('emp_1').length, 4); // F29 + Previred, 2 avisos cada uno
    assert.equal(de('emp_3').length, 0);
    const prev = de('emp_1').filter((r) => r.tipo === 'previred').map((r) => r.enviarEl);
    assert.deepEqual(prev, ['2026-11-11', '2026-11-12']);
    const f29 = de('emp_1').filter((r) => r.tipo === 'f29').map((r) => r.enviarEl);
    assert.deepEqual(f29, ['2026-11-18', '2026-11-19']);
  });

  it('el correo usa la plantilla provisoria con la fecha dd/mm/aaaa', () => {
    const r = plan.recordatorios.find((x) => x.tipo === 'previred')!;
    assert.match(r.cuerpo, /con fecha 13\/11\/2026 vence el pago correspondiente de cotizaciones/);
    assert.equal(plan.plantillaProvisoria, true);
  });

  it('alerta lo que impide o complica el envío', () => {
    const tipos = plan.alertas.map((a) => `${a.tipo}:${a.empresa}`);
    assert.ok(tipos.includes('sin_correo:Sin correo'));
    assert.ok(tipos.includes('sin_encargado:Sin correo'));
    assert.ok(tipos.includes('rut_invalido:RUT malo'));
    assert.ok(tipos.includes('sin_obligaciones:RUT malo'));
  });

  it('el CSV marca SIN CORREO y los avisos que ya pasaron', () => {
    const csv = planACsv(armarPlan(empresas, { mes: '2026-11', hoy: '2026-11-12', feriados: new Set() }));
    assert.match(csv, /SIN CORREO/);
    assert.match(csv, /Fecha pasada/);
    assert.match(csv, /Pendiente/);
  });
});
