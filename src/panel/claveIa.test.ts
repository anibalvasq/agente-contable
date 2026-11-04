import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createMemoryEquipoStore } from '../auth/equipo.js';
import type { Autenticador } from '../auth/supabase.js';
import { ErrorAnthropic, llamarAnthropic, redactarClaves } from './anthropic.js';
import { responderConClaude } from './assistant.js';
import { createClaveIaService, createMemoryClaveStore, ErrorClave } from './claveIa.js';
import { registerPanel } from './routes.js';
import { createFileStore } from './store.js';

const KEY = 'sk-ant-api03-' + 'a'.repeat(30);
const OTRA = 'sk-ant-api03-' + 'b'.repeat(30);

function servicio(llamar: Parameters<typeof createClaveIaService>[0]['llamar'] = async () => ({ content: [] })) {
  const store = createMemoryClaveStore();
  return { store, svc: createClaveIaService({ store, llave: randomBytes(32), modelo: 'm', llamar }) };
}

describe('API key del estudio', () => {
  it('rechaza lo que no parece una key sin llamar a Anthropic', async () => {
    let llamadas = 0;
    const { svc } = servicio(async () => (llamadas++, { content: [] }));
    await assert.rejects(svc.guardar('hola', 'ana@e.cl'), (e: ErrorClave) => e.codigo === 'formato_invalido');
    assert.equal(llamadas, 0);
  });

  it('verifica con una llamada mínima y la guarda CIFRADA: en claro no queda en ninguna parte', async () => {
    const llamadas: { max_tokens: number }[] = [];
    const { svc, store } = servicio(async (_k, p) => (llamadas.push(p), { content: [] }));
    assert.deepEqual(await svc.guardar(` ${KEY} `, 'ana@e.cl'), { estado: 'activa', ultimos4: 'aaaa', por: 'ana@e.cl' });
    assert.equal(llamadas[0]?.max_tokens, 1);
    const fila = await store.get();
    assert.ok(fila && !fila.cifrada.includes(KEY) && !fila.cifrada.includes('sk-ant'));
    assert.equal(await svc.usar(), KEY);
    assert.deepEqual(await svc.estado(), { estado: 'activa', ultimos4: 'aaaa', por: 'ana@e.cl' });
  });

  it('si Anthropic rechaza la key, no se guarda nada', async () => {
    const { svc } = servicio(async () => {
      throw new ErrorAnthropic('clave_invalida', 401);
    });
    await assert.rejects(svc.guardar(KEY, 'ana@e.cl'), (e: ErrorClave) => e.codigo === 'clave_rechazada');
    assert.deepEqual(await svc.estado(), { estado: 'sin_clave' });
  });

  it('con otra llave de cifrado (o la fila alterada) la key no se descifra y queda inválida', async () => {
    const store = createMemoryClaveStore();
    const a = createClaveIaService({ store, llave: randomBytes(32), modelo: 'm', llamar: async () => ({ content: [] }) });
    await a.guardar(KEY, 'ana@e.cl');
    const b = createClaveIaService({ store, llave: randomBytes(32), modelo: 'm' });
    await assert.rejects(b.usar(), (e: ErrorClave) => e.codigo === 'clave_invalida');
    assert.equal((await b.estado()).estado, 'invalida');
  });

  it('marcada inválida pide reemplazo; reemplazar y eliminar funcionan', async () => {
    const { svc } = servicio();
    await svc.guardar(KEY, 'ana@e.cl');
    await svc.marcarInvalida();
    await assert.rejects(svc.usar(), (e: ErrorClave) => e.codigo === 'clave_invalida');
    await svc.guardar(OTRA, 'beto@e.cl');
    assert.equal(await svc.usar(), OTRA);
    await svc.eliminar();
    await assert.rejects(svc.usar(), (e: ErrorClave) => e.codigo === 'sin_clave');
  });
});

describe('cliente de Anthropic', () => {
  const resp = (status: number, cuerpo: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(cuerpo), { status, headers });
  const p = { model: 'm', max_tokens: 1, messages: [{ role: 'user' as const, content: 'x' }] };

  it('401/403 es clave inválida y no se reintenta', async () => {
    let n = 0;
    const fetchFn = (async () => (n++, resp(401))) as typeof fetch;
    await assert.rejects(llamarAnthropic(KEY, p, { fetchFn, esperar: async () => {} }), (e: ErrorAnthropic) => e.tipo === 'clave_invalida');
    assert.equal(n, 1);
  });

  it('429 y 529 se reintentan con espera y luego se rinden', async () => {
    let n = 0;
    const esperas: number[] = [];
    const fetchFn = (async () => (n++, resp(529))) as typeof fetch;
    await assert.rejects(llamarAnthropic(KEY, p, { fetchFn, esperar: async (ms) => void esperas.push(ms) }), (e: ErrorAnthropic) => e.tipo === 'no_disponible');
    assert.equal(n, 3);
    assert.deepEqual(esperas, [500, 1500]);
  });

  it('un 429 que se recupera devuelve la respuesta', async () => {
    let n = 0;
    const fetchFn = (async () => (++n === 1 ? resp(429, {}, { 'retry-after': '1' }) : resp(200, { content: [{ type: 'text', text: 'ok' }] }))) as typeof fetch;
    const r = await llamarAnthropic(KEY, p, { fetchFn, esperar: async () => {} });
    assert.equal(r.content[0]?.type, 'text');
  });

  it('el error no contiene la key ni el cuerpo de la respuesta', async () => {
    const fetchFn = (async () => resp(400, { error: { message: `bad ${KEY}` } })) as typeof fetch;
    await assert.rejects(llamarAnthropic(KEY, p, { fetchFn }), (e: Error) => !e.message.includes('sk-ant'));
    assert.equal(redactarClaves(`x ${KEY} y`), 'x sk-ant-… y');
  });
});

describe('asistente con la key del estudio', () => {
  it('traduce mensajes y herramientas al formato de Anthropic y de vuelta', async () => {
    let visto: any;
    const r = await responderConClaude(
      {
        datos: 'DATOS',
        mensajes: [
          { role: 'user', content: 'busca' },
          { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'buscar_movimientos', arguments: '{"mes":3}' } }, { id: 't2', type: 'function', function: { name: 'buscar_movimientos', arguments: '{"mes":4}' } }] },
          { role: 'tool', tool_call_id: 't1', content: '{"n":1}' },
          { role: 'tool', tool_call_id: 't2', content: '{"n":2}' },
        ],
      },
      KEY,
      {
        llamar: async (_k, p) => {
          visto = p;
          return { content: [{ type: 'text', text: 'listo' }, { type: 'tool_use', id: 'u9', name: 'buscar_movimientos', input: { mes: 5 } }] };
        },
      },
    );
    assert.equal(visto.messages.length, 3); // usuario, asistente con 2 tool_use, UN usuario con 2 tool_result
    assert.equal(visto.messages[2].content.length, 2);
    assert.equal(visto.messages[1].content[0].input.mes, 3);
    assert.equal(visto.tools[0].name, 'buscar_movimientos');
    assert.match(visto.system, /DATOS/);
    assert.equal(r.content, 'listo');
    assert.deepEqual(r.tool_calls, [{ id: 'u9', type: 'function', function: { name: 'buscar_movimientos', arguments: '{"mes":5}' } }]);
  });
});

describe('rutas de la API key', () => {
  async function armar(responder?: (b: unknown, k?: string) => Promise<unknown>) {
    const equipo = createMemoryEquipoStore();
    await equipo.insert({ userId: 'u-ana', email: 'ana@e.cl', nombre: 'Ana', rol: 'admin', activo: true });
    await equipo.insert({ userId: 'u-beto', email: 'beto@e.cl', nombre: 'Beto', rol: 'equipo', activo: true });
    const auth: Autenticador = {
      config: { url: 'https://x', publishableKey: 'p' },
      equipo,
      verificar: async (t) => {
        const m = await equipo.get(t.replace('tok-', 'u-'));
        return m ? { estado: 'ok', miembro: m } : { estado: 'invalido' };
      },
      crear: async () => {
        throw new Error('no');
      },
      olvidar: () => {},
    };
    const { svc, store } = servicio();
    const app = Fastify();
    const dir = await mkdtemp(path.join(tmpdir(), 'panel-'));
    await registerPanel(app, { store: createFileStore(path.join(dir, 'p.json')), clave: undefined, produccion: true, auth, claveIa: svc, ...(responder ? { responder } : {}) });
    const h = (u: string) => ({ authorization: `Bearer tok-${u}` });
    return { app, h, store };
  }
  const consulta = { datos: 'd', mensajes: [{ role: 'user', content: 'hola' }] };
  const guardar = (app: Awaited<ReturnType<typeof armar>>['app'], quien: { authorization: string }, clave: string = KEY) =>
    app.inject({ method: 'POST', url: '/panel/api/ia/clave', headers: quien, payload: { clave } });

  it('sin key el asistente responde 428 y no llama al modelo', async () => {
    let llamado = false;
    const { app, h } = await armar(async () => ((llamado = true), {}));
    const r = await app.inject({ method: 'POST', url: '/panel/api/asistente', headers: h('beto'), payload: consulta });
    assert.equal(r.statusCode, 428);
    assert.equal(r.json().error, 'sin_clave');
    assert.equal(llamado, false);
  });

  it('solo un administrador configura o elimina la key', async () => {
    const { app, h } = await armar();
    assert.equal((await guardar(app, h('beto'))).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/panel/api/ia/clave', headers: h('beto') })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/panel/api/ia/clave', payload: { clave: KEY } })).statusCode, 401);
    assert.equal((await guardar(app, h('ana'))).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: '/panel/api/ia/clave', headers: h('beto') })).statusCode, 403);
    assert.equal((await app.inject({ method: 'DELETE', url: '/panel/api/ia/clave', headers: h('ana') })).statusCode, 204);
  });

  it('el admin guarda una key y todo el equipo la usa; nunca se devuelve ni se guarda en claro', async () => {
    const usadas: (string | undefined)[] = [];
    const { app, h, store } = await armar(async (_b, k) => (usadas.push(k), { content: 'ok', tool_calls: [] }));
    const g = await guardar(app, h('ana'));
    assert.equal(g.statusCode, 200);
    assert.ok(!g.body.includes(KEY) && g.headers['cache-control'] === 'no-store');
    assert.ok(!(await store.get())!.cifrada.includes('sk-ant'));
    // El admin ve el detalle; el equipo solo si el asistente está disponible.
    assert.deepEqual((await app.inject({ url: '/panel/api/ia/clave', headers: h('ana') })).json(), { estado: 'activa', ultimos4: 'aaaa', por: 'ana@e.cl' });
    assert.deepEqual((await app.inject({ url: '/panel/api/ia/clave', headers: h('beto') })).json(), { estado: 'activa' });
    assert.equal((await app.inject({ method: 'POST', url: '/panel/api/asistente', headers: h('beto'), payload: consulta })).statusCode, 200);
    assert.deepEqual(usadas, [KEY]);
  });

  it('si Anthropic rechaza la key al consultar, queda inválida y pide reemplazo', async () => {
    const { app, h } = await armar(async () => {
      throw new ErrorAnthropic('clave_invalida', 401);
    });
    await guardar(app, h('ana'));
    const r = await app.inject({ method: 'POST', url: '/panel/api/asistente', headers: h('beto'), payload: consulta });
    assert.equal(r.statusCode, 428);
    assert.equal(r.json().error, 'clave_invalida');
    assert.equal((await app.inject({ url: '/panel/api/ia/clave', headers: h('ana') })).json().estado, 'invalida');
  });

  it('exige sesión y limita las consultas por persona', async () => {
    const { app, h } = await armar(async () => ({ content: 'ok', tool_calls: [] }));
    assert.equal((await app.inject({ url: '/panel/api/ia/clave' })).statusCode, 401);
    await guardar(app, h('ana'));
    let ultimo = 0;
    for (let i = 0; i < 31; i++) ultimo = (await app.inject({ method: 'POST', url: '/panel/api/asistente', headers: h('beto'), payload: consulta })).statusCode;
    assert.equal(ultimo, 429);
    // El tope es por persona: otra no queda bloqueada.
    assert.equal((await app.inject({ method: 'POST', url: '/panel/api/asistente', headers: h('ana'), payload: consulta })).statusCode, 200);
  });
});
