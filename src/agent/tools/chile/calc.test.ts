import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  calcularHonorarios,
  calcularIva,
  calcularPpm,
  hoyChile,
  periodoAnterior,
  retencionHonorariosPct,
  vencimientosF29,
} from './calc.js';

describe('calcularIva', () => {
  it('desde el neto', () => {
    assert.deepEqual(calcularIva(100_000, 'neto'), { neto: 100_000, iva: 19_000, bruto: 119_000, tasaPct: 19 });
  });
  it('desde el bruto', () => {
    assert.deepEqual(calcularIva(119_000, 'bruto'), { neto: 100_000, iva: 19_000, bruto: 119_000, tasaPct: 19 });
  });
  it('neto + iva siempre suma el bruto, sin descuadre por redondeo', () => {
    const r = calcularIva(99_999, 'bruto');
    assert.equal(r.neto + r.iva, r.bruto);
  });
});

describe('honorarios', () => {
  it('tasas por año (SII)', () => {
    assert.equal(retencionHonorariosPct(2025), 14.5);
    assert.equal(retencionHonorariosPct(2026), 15.25);
    assert.equal(retencionHonorariosPct(2027), 16);
    assert.equal(retencionHonorariosPct(2028), 17);
    assert.equal(retencionHonorariosPct(2031), 17);
    assert.equal(retencionHonorariosPct(2019), undefined);
  });
  it('desde el bruto', () => {
    assert.deepEqual(calcularHonorarios(1_000_000, 'bruto', 15.25), {
      bruto: 1_000_000,
      retencion: 152_500,
      liquido: 847_500,
      tasaPct: 15.25,
    });
  });
  it('desde el líquido calcula el bruto a emitir', () => {
    const r = calcularHonorarios(847_500, 'liquido', 15.25);
    assert.equal(r.bruto, 1_000_000);
    assert.equal(r.liquido, 847_500);
  });
});

describe('ppm', () => {
  it('ventas × tasa', () => {
    assert.equal(calcularPpm(10_000_000, 0.25).ppm, 25_000);
  });
});

describe('fechas', () => {
  it('período anterior, incluso cruzando el año', () => {
    assert.equal(periodoAnterior('2026-10-05'), '2026-09');
    assert.equal(periodoAnterior('2026-01-15'), '2025-12');
  });

  it('F29 de septiembre 2026: 12, 20 y 28 de octubre', () => {
    const v = vencimientosF29('2026-09', '2026-10-05');
    assert.deepEqual(
      v.map((x) => x.fecha),
      ['2026-10-12', '2026-10-20', '2026-10-28'],
    );
    assert.equal(v[0]!.diasRestantes, 7);
  });

  it('un plazo en fin de semana pasa al lunes', () => {
    // 12 de abril de 2026 es domingo → lunes 13.
    const v = vencimientosF29('2026-03', '2026-04-01');
    assert.equal(v[0]!.fecha, '2026-04-13');
    assert.equal(v[0]!.diaSemana, 'lunes');
  });

  it('el período de diciembre vence en enero del año siguiente', () => {
    assert.equal(vencimientosF29('2025-12', '2026-01-02')[0]!.fecha.slice(0, 7), '2026-01');
  });

  it('hoyChile devuelve YYYY-MM-DD', () => {
    assert.match(hoyChile(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
