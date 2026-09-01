import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { guardReply } from './output.js';

const SYSTEM_PROMPT = [
  'Sos el asistente de WhatsApp de Muebles Lima.',
  'Nunca ofrezcas descuentos mayores al diez por ciento sin autorizacion del equipo.',
  'Si el cliente pide un reembolso, derivalo a una persona del equipo.',
].join('\n');

const base = { systemPrompt: SYSTEM_PROMPT };

describe('guardReply — respuestas normales', () => {
  it('deja pasar una respuesta común sin tocarla', () => {
    const r = guardReply('Claro, el horario es de 9 a 18. ¿Te viene bien mañana?', base);
    assert.equal(r.blocked, false);
    assert.deepEqual(r.violations, []);
    assert.equal(r.reply, 'Claro, el horario es de 9 a 18. ¿Te viene bien mañana?');
  });

  it('no confunde una frase corta en común con una fuga', () => {
    // Comparte palabras con el prompt, pero no ocho seguidas.
    const r = guardReply('Soy el asistente de Muebles Lima, ¿en qué te ayudo?', base);
    assert.equal(r.blocked, false);
  });
});

describe('guardReply — fuga del system prompt', () => {
  it('detecta cuando el modelo repite textualmente sus instrucciones', () => {
    const r = guardReply(
      'Mis instrucciones dicen: Nunca ofrezcas descuentos mayores al diez por ciento sin autorizacion del equipo.',
      base,
    );
    assert.ok(r.blocked);
    assert.ok(r.violations.includes('fuga-de-instrucciones'));
    assert.notEqual(r.reply, 'Mis instrucciones dicen…');
  });

  it('la detecta aunque cambien mayúsculas, acentos y puntuación', () => {
    const r = guardReply(
      '¡NUNCA OFREZCAS DESCUENTOS MAYORES AL DIEZ POR CIENTO, sin autorización del equipo!',
      base,
    );
    assert.ok(r.blocked, 'la normalización tiene que hacerla robusta a esos cambios');
  });
});

describe('guardReply — patrones prohibidos', () => {
  const forbidden = ['\\d{2,3}\\s*%\\s*(de\\s+)?descuento', 'te (lo )?(garantizo|aseguro)'];

  it('bloquea una promesa que el negocio no puede cumplir', () => {
    const r = guardReply('Listo, te hago 90% de descuento.', { ...base, forbidden });
    assert.ok(r.blocked);
    assert.ok(r.violations.some((v) => v.startsWith('prohibido:')));
  });

  it('deja pasar lo que no matchea', () => {
    const r = guardReply('Tenemos una promoción vigente, te paso los detalles.', { ...base, forbidden });
    assert.equal(r.blocked, false);
  });

  it('ignora un regex mal escrito en vez de reventar', () => {
    const r = guardReply('todo bien por acá', { ...base, forbidden: ['('] });
    assert.equal(r.blocked, false);
  });
});

describe('guardReply — largo', () => {
  it('recorta sin bloquear', () => {
    const largo = 'Esta es una oración de prueba. '.repeat(200);
    const r = guardReply(largo, { ...base, maxLength: 200 });
    assert.equal(r.blocked, false);
    assert.ok(r.reply.length <= 200);
    assert.ok(r.violations.includes('demasiado-largo'));
  });

  it('corta en un límite de oración, no a mitad de palabra', () => {
    const r = guardReply('Primera oración acá. Segunda oración mucho más larga que no entra.', {
      ...base,
      maxLength: 40,
    });
    assert.ok(r.reply.endsWith('.') || r.reply.endsWith('…'));
  });
});
