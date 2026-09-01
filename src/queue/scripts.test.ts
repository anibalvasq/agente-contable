import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import RedisMock from 'ioredis-mock';
import {
  bufKey,
  CLAIM_LUA,
  ENQUEUE_LUA,
  lockKey,
  pendKey,
  procKey,
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
  RETURN_LUA,
  seqKey,
  TTL,
} from './scripts.js';

/**
 * Los scripts Lua corren contra un Redis en memoria. No es Redis de verdad,
 * pero ejecuta el Lua real: alcanza para verificar la lógica del claim/ack/
 * return, que es la que evita perder mensajes.
 */
let redis: InstanceType<typeof RedisMock>;
const CONV = 'conv-1';

beforeEach(async () => {
  redis = new RedisMock();
  // ioredis-mock comparte los datos entre instancias con la misma config, así
  // que `new` no alcanza para empezar limpio.
  await redis.flushall();
});

const claim = (jobId: string) =>
  redis.eval(CLAIM_LUA, 2, bufKey(CONV), procKey(CONV, jobId), String(TTL)) as Promise<string[]>;

const devolver = (jobId: string) =>
  redis.eval(RETURN_LUA, 2, procKey(CONV, jobId), bufKey(CONV), String(TTL)) as Promise<number>;

const encolar = (texto: string) =>
  redis.eval(ENQUEUE_LUA, 3, bufKey(CONV), seqKey(CONV), pendKey(CONV), texto, String(TTL), CONV) as Promise<
    [string, string]
  >;

describe('ENQUEUE_LUA', () => {
  it('acumula los mensajes y devuelve el jobId nuevo', async () => {
    const [jobId, previo] = await encolar('hola');
    assert.equal(jobId, 'conv-1__1');
    assert.equal(previo, '', 'el primer mensaje no tiene job anterior que cancelar');
    assert.deepEqual(await redis.lrange(bufKey(CONV), 0, -1), ['hola']);
  });

  it('devuelve el job anterior para cancelarlo (así funciona el debounce)', async () => {
    await encolar('hola');
    const [jobId, previo] = await encolar('che');
    assert.equal(jobId, 'conv-1__2');
    assert.equal(previo, 'conv-1__1');
    assert.deepEqual(await redis.lrange(bufKey(CONV), 0, -1), ['hola', 'che']);
  });

  it('el jobId coincide con el formato de buildJobId', async () => {
    const [jobId] = await encolar('x');
    assert.ok(!jobId.includes(':'), 'BullMQ rechaza los : en un id custom');
    assert.ok(jobId.includes('__'));
  });
});

describe('CLAIM_LUA', () => {
  it('mueve el buffer a la lista del job y lo vacía', async () => {
    await encolar('hola');
    await encolar('che');

    assert.deepEqual(await claim('job-1'), ['hola', 'che']);
    assert.deepEqual(await redis.lrange(bufKey(CONV), 0, -1), [], 'el buffer queda vacío');
    assert.deepEqual(
      await redis.lrange(procKey(CONV, 'job-1'), 0, -1),
      ['hola', 'che'],
      'pero los mensajes NO se borran: quedan en la lista del job',
    );
  });

  it('un reintento del mismo job recupera sus mensajes', async () => {
    // Este es EL caso que antes perdía mensajes: el buffer se vaciaba antes de
    // llamar al modelo, y si el LLM fallaba el reintento no encontraba nada.
    await encolar('cual es el horario');
    assert.deepEqual(await claim('job-1'), ['cual es el horario']);

    // …falla el LLM, BullMQ reintenta el mismo job…
    assert.deepEqual(await claim('job-1'), ['cual es el horario'], 'el reintento tiene que verlos de nuevo');
  });

  it('el reintento suma lo que llegó mientras tanto, en orden', async () => {
    await encolar('primero');
    await claim('job-1');
    await encolar('segundo'); // el usuario siguió escribiendo

    assert.deepEqual(await claim('job-1'), ['primero', 'segundo']);
  });

  it('un job distinto NO se lleva los mensajes de otro', async () => {
    // Si la lista fuera compartida, el usuario recibiría dos respuestas.
    await encolar('hola');
    await claim('job-1');

    assert.deepEqual(await claim('job-2'), [], 'job-2 no debe ver lo que tomó job-1');
    assert.deepEqual(await redis.lrange(procKey(CONV, 'job-1'), 0, -1), ['hola']);
  });

  it('devuelve vacío si no hay nada', async () => {
    assert.deepEqual(await claim('job-1'), []);
  });
});

describe('ACK (borrar la lista del job)', () => {
  it('descarta los mensajes cuando el turno terminó bien', async () => {
    await encolar('hola');
    await claim('job-1');

    await redis.del(procKey(CONV, 'job-1'));

    assert.deepEqual(await claim('job-1'), [], 'después del ack no queda nada que reprocesar');
  });
});

describe('RETURN_LUA', () => {
  it('devuelve los mensajes al buffer conservando el orden', async () => {
    await encolar('uno');
    await encolar('dos');
    await claim('job-1');

    assert.equal(await devolver('job-1'), 2);
    assert.deepEqual(await redis.lrange(bufKey(CONV), 0, -1), ['uno', 'dos']);
    assert.deepEqual(await redis.lrange(procKey(CONV, 'job-1'), 0, -1), []);
  });

  it('los pone ADELANTE de lo que llegó después', async () => {
    await encolar('viejo');
    await claim('job-1');
    await encolar('nuevo');

    await devolver('job-1');
    assert.deepEqual(
      await redis.lrange(bufKey(CONV), 0, -1),
      ['viejo', 'nuevo'],
      'el orden cronológico tiene que sobrevivir al fallo',
    );
  });

  it('no hace nada si no hay mensajes tomados', async () => {
    assert.equal(await devolver('job-1'), 0);
  });
});

describe('locks', () => {
  const TOKEN = 'token-abc';

  it('renueva solo si el token es el nuestro', async () => {
    await redis.set(lockKey(CONV), TOKEN, 'PX', 60_000);

    const propio = await redis.eval(RENEW_LOCK_LUA, 1, lockKey(CONV), TOKEN, '300000');
    assert.equal(propio, 1);

    const ajeno = await redis.eval(RENEW_LOCK_LUA, 1, lockKey(CONV), 'otro-token', '300000');
    assert.equal(ajeno, 0, 'un worker zombi no debe renovar el lock que ya tomó otro');
  });

  it('libera solo si el token es el nuestro', async () => {
    await redis.set(lockKey(CONV), TOKEN, 'PX', 60_000);

    assert.equal(await redis.eval(RELEASE_LOCK_LUA, 1, lockKey(CONV), 'otro-token'), 0);
    assert.equal(await redis.get(lockKey(CONV)), TOKEN, 'el lock ajeno sigue en pie');

    assert.equal(await redis.eval(RELEASE_LOCK_LUA, 1, lockKey(CONV), TOKEN), 1);
    assert.equal(await redis.get(lockKey(CONV)), null);
  });
});
