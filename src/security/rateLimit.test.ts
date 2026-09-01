import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRateLimiter } from './rateLimit.js';

describe('MemoryRateLimiter', () => {
  it('deja pasar hasta el límite y después corta', async () => {
    const rl = new MemoryRateLimiter();
    for (let i = 0; i < 3; i++) {
      const r = await rl.hit('contacto:51999', 3, 60_000);
      assert.ok(r.allowed, `el hit ${i + 1} tenía que pasar`);
    }
    const cuarto = await rl.hit('contacto:51999', 3, 60_000);
    assert.equal(cuarto.allowed, false);
    assert.ok(cuarto.retryAfterMs > 0);
  });

  it('lleva cuentas separadas por clave', async () => {
    const rl = new MemoryRateLimiter();
    await rl.hit('a', 1, 60_000);
    assert.equal((await rl.hit('a', 1, 60_000)).allowed, false);
    assert.equal((await rl.hit('b', 1, 60_000)).allowed, true, 'un abusador no debe afectar a otro contacto');
  });

  it('libera al vencer la ventana', async () => {
    const rl = new MemoryRateLimiter();
    await rl.hit('a', 1, 1); // ventana de 1 ms
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await rl.hit('a', 1, 1)).allowed, true);
  });

  it('informa cuántos hits quedan', async () => {
    const rl = new MemoryRateLimiter();
    assert.equal((await rl.hit('a', 5, 60_000)).remaining, 4);
    assert.equal((await rl.hit('a', 5, 60_000)).remaining, 3);
  });
});
