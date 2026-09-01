import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ALERT_THROTTLE_MS, resetAlertThrottle, sendAlert, shouldSendAlert } from './email.js';

/**
 * Estos tests protegen contra el fallo clásico de los avisos automáticos:
 * mandar un mail por cada error. Cuando el proveedor del LLM se cae diez
 * minutos, fallan cientos de turnos y llegan cientos de mails idénticos — la
 * casilla queda inútil justo el día que la necesitabas, y encima quemás la
 * cuota de Resend.
 */
describe('freno de avisos', () => {
  beforeEach(() => {
    resetAlertThrottle();
  });

  it('deja pasar el primero', () => {
    assert.equal(shouldSendAlert('turno-abandonado', 0), 0, 'el primer aviso siempre sale, y sin omitidos');
  });

  it('frena los repetidos dentro de la ventana', () => {
    shouldSendAlert('turno-abandonado', 0);

    // El escenario real: se cayó OpenRouter y fallan 300 turnos seguidos.
    for (let i = 1; i <= 300; i++) {
      assert.equal(shouldSendAlert('turno-abandonado', i * 100), null, `el aviso ${i} debía frenarse`);
    }
  });

  it('al vencer la ventana vuelve a pasar, e informa cuántos se omitieron', () => {
    shouldSendAlert('turno-abandonado', 0);
    shouldSendAlert('turno-abandonado', 1_000);
    shouldSendAlert('turno-abandonado', 2_000);

    const omitidos = shouldSendAlert('turno-abandonado', ALERT_THROTTLE_MS);
    assert.equal(omitidos, 2, 'el aviso nuevo tiene que contar los dos que se frenaron');
  });

  it('el contador de omitidos se reinicia en cada envío', () => {
    shouldSendAlert('k', 0);
    shouldSendAlert('k', 1_000);
    assert.equal(shouldSendAlert('k', ALERT_THROTTLE_MS), 1);
    // La segunda ventana arranca limpia: no arrastra el omitido de la primera.
    assert.equal(shouldSendAlert('k', ALERT_THROTTLE_MS * 2), 0);
  });

  it('claves distintas son problemas distintos', () => {
    assert.equal(shouldSendAlert('turno-abandonado', 0), 0);
    assert.equal(shouldSendAlert('presupuesto-diario', 0), 0, 'un problema no debe tapar al otro');
    assert.equal(shouldSendAlert('handoff:conv-1', 0), 0);
    assert.equal(shouldSendAlert('handoff:conv-2', 0), 0, 'dos clientes distintos son dos avisos');
  });

  it('la ventana es lo bastante larga para que sirva', () => {
    assert.ok(ALERT_THROTTLE_MS >= 5 * 60_000, 'menos de 5 minutos no frena una caída del proveedor');
  });
});

describe('sendAlert', () => {
  beforeEach(() => {
    resetAlertThrottle();
  });

  it('no lanza cuando no está configurado', async () => {
    // Sin RESEND_API_KEY el kit funciona igual: el aviso queda en los logs.
    // Un fallo del mail nunca puede tumbar el turno que lo originó.
    await assert.doesNotReject(() => sendAlert({ key: 'k', subject: 's', body: 'b' }));
  });
});
