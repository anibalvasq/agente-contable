import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suggestDailyBudget, TOKENS_POR_CONVERSACION } from './budgetSizing.js';

/**
 * Estos tests protegen un default que ya salió mal una vez.
 *
 * La primera versión del kit traía max_tokens_per_day = 2.000.000, que suena a
 * mucho y alcanza para ~55 conversaciones diarias. Un negocio normal tocaba el
 * techo a media tarde y a partir de ahí TODOS sus clientes recibían el mensaje
 * de "estoy con muchas consultas". El bot no fallaba: se apagaba solo, en
 * silencio, y el dueño no tenía forma de saber por qué.
 */
describe('suggestDailyBudget', () => {
  it('cubre holgadamente el volumen declarado', () => {
    const conversaciones = 400;
    const budget = suggestDailyBudget(conversaciones);
    const consumoNormal = conversaciones * TOKENS_POR_CONVERSACION;

    assert.ok(budget > consumoNormal, 'un día normal NUNCA debe disparar el corte');
    assert.equal(budget / consumoNormal, 3, 'con el margen de 3x');
  });

  it('el default del kit aguanta un negocio real', () => {
    // 150 conversaciones/día es un negocio chico-mediano andando bien.
    // El default de config.ts tiene que cubrirlo sin que nadie lo toque.
    assert.equal(suggestDailyBudget(150), 18_000_000);
    assert.ok(20_000_000 >= suggestDailyBudget(150), 'el default de config.ts debe cubrir este caso');
  });

  it('sigue frenando un loop descontrolado', () => {
    // Un loop con el autoresponder de otro bot quema ~3,7M tokens por hora.
    const porHoraEnLoop = 3_700_000;
    const budget = suggestDailyBudget(150);

    assert.ok(budget / porHoraEnLoop < 12, 'tiene que cortar antes de una noche entera');
  });

  it('pone un piso, para que un cero no apague el agente', () => {
    // Si alguien contesta "0" o escribe cualquier cosa en la entrevista, el
    // resultado no puede ser un presupuesto de cero: eso deja el bot mudo.
    assert.equal(suggestDailyBudget(0), 10 * TOKENS_POR_CONVERSACION * 3);
    assert.equal(suggestDailyBudget(Number.NaN), 10 * TOKENS_POR_CONVERSACION * 3);
    assert.equal(suggestDailyBudget(-5), 10 * TOKENS_POR_CONVERSACION * 3);
  });

  it('escala de forma lineal', () => {
    assert.equal(suggestDailyBudget(1_000), suggestDailyBudget(500) * 2);
  });
});
