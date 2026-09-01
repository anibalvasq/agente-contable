import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { issueSessionId, verifySessionId } from './sessions.js';

const SECRET = 'un-secreto-de-prueba';

describe('sesiones firmadas', () => {
  it('acepta un id que emitió el server', () => {
    const emitido = issueSessionId(SECRET);
    assert.ok(verifySessionId(emitido, SECRET));
  });

  it('rechaza un id inventado por el cliente', () => {
    // Este era el agujero: el cliente mandaba el sessionId que quería y podía
    // retomar la conversación de otra persona.
    assert.equal(verifySessionId('web-abc123', SECRET), null);
    assert.equal(verifySessionId('victima.deadbeef', SECRET), null);
    assert.equal(verifySessionId('', SECRET), null);
    assert.equal(verifySessionId(undefined, SECRET), null);
    assert.equal(verifySessionId(42, SECRET), null);
  });

  it('rechaza un id manipulado', () => {
    const emitido = issueSessionId(SECRET);
    const [id, firma] = emitido.split('.');
    assert.equal(verifySessionId(`${id}0.${firma}`, SECRET), null, 'id cambiado');
    assert.equal(verifySessionId(`${id}.${'0'.repeat(32)}`, SECRET), null, 'firma cambiada');
  });

  it('rechaza un id firmado con otro secreto', () => {
    assert.equal(verifySessionId(issueSessionId('otro-secreto'), SECRET), null);
  });

  it('devuelve el id crudo, sin la firma', () => {
    const emitido = issueSessionId(SECRET);
    assert.equal(verifySessionId(emitido, SECRET), emitido.split('.')[0]);
  });

  it('emite ids distintos', () => {
    const ids = new Set(Array.from({ length: 50 }, () => issueSessionId(SECRET)));
    assert.equal(ids.size, 50);
  });
});
