import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createMemoryEquipoStore } from './equipo.js';
import { createAutenticador, ErrorAuth } from './supabase.js';
import { registerPanel } from '../panel/routes.js';
import { createFileStore } from '../panel/store.js';

/** Un Supabase de mentira: tokens → usuarios, y un registro de las llamadas administrativas. */
function supabaseFalso() {
  const tokens = new Map<string, string>([['tok-ana', 'u-ana'], ['tok-beto', 'u-beto'], ['tok-intruso', 'u-intruso']]);
  const llamadas: string[] = [];
  let siguiente = 100;
  const existentes = new Set(['otra@app.cl']);
  const fetchFalso = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    llamadas.push(`${init?.method ?? 'GET'} ${u.replace('https://x.supabase.co', '')}`);
    if (u.endsWith('/auth/v1/user')) {
      const id = tokens.get(auth.replace('Bearer ', ''));
      return id ? Response.json({ id }) : new Response('{}', { status: 401 });
    }
    if (u.endsWith('/auth/v1/admin/users') && init?.method === 'POST') {
      assert.equal(auth, 'Bearer service-secreta'); // la creación usa la service key, nunca la pública
      const { email } = JSON.parse(String(init.body)) as { email: string };
      if (existentes.has(email)) return new Response('{}', { status: 422 });
      return Response.json({ id: `u-${siguiente++}` });
    }
    if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchFalso, llamadas };
}

async function armar() {
  const { fetchFalso, llamadas } = supabaseFalso();
  const equipo = createMemoryEquipoStore();
  await equipo.insert({ userId: 'u-ana', email: 'ana@estudio.cl', nombre: 'Ana', rol: 'admin', activo: true });
  await equipo.insert({ userId: 'u-beto', email: 'beto@estudio.cl', nombre: 'Beto', rol: 'equipo', activo: true });
  const auth = createAutenticador({ url: 'https://x.supabase.co/', publishableKey: 'pub', serviceKey: 'service-secreta' }, equipo, fetchFalso);
  return { auth, equipo, llamadas };
}

describe('validación de la sesión', () => {
  it('deja entrar a un miembro activo', async () => {
    const { auth } = await armar();
    const v = await auth.verificar('tok-ana');
    assert.equal(v.estado, 'ok');
    assert.equal(v.estado === 'ok' && v.miembro.rol, 'admin');
  });
  it('un token falso o vencido es inválido', async () => {
    assert.deepEqual(await (await armar()).auth.verificar('cualquiera'), { estado: 'invalido' });
  });
  it('una cuenta válida que NO es del estudio no entra (p. ej. usuarios de otra app del mismo proyecto)', async () => {
    assert.deepEqual(await (await armar()).auth.verificar('tok-intruso'), { estado: 'sin_acceso' });
  });
  it('un miembro desactivado deja de entrar aunque su sesión siga vigente', async () => {
    const { auth, equipo } = await armar();
    assert.equal((await auth.verificar('tok-beto')).estado, 'ok');
    await equipo.update('u-beto', { activo: false });
    assert.equal((await auth.verificar('tok-beto')).estado, 'sin_acceso');
  });
  it('la caché evita preguntarle a Supabase en cada request', async () => {
    const { auth, llamadas } = await armar();
    await auth.verificar('tok-ana');
    await auth.verificar('tok-ana');
    assert.equal(llamadas.filter((l) => l.endsWith('/auth/v1/user')).length, 1);
  });
});

describe('creación de cuentas', () => {
  it('crea la cuenta en Auth y la registra en equipo', async () => {
    const { auth, equipo } = await armar();
    const m = await auth.crear({ email: ' Nueva@Estudio.cl ', nombre: 'Nueva', rol: 'equipo', password: 'una-clave-larga' });
    assert.equal(m.email, 'nueva@estudio.cl');
    assert.equal((await equipo.get(m.userId))?.rol, 'equipo');
  });
  it('rechaza claves cortas y correos inválidos sin llamar a Supabase', async () => {
    const { auth, llamadas } = await armar();
    await assert.rejects(auth.crear({ email: 'a@b.cl', nombre: 'X', rol: 'equipo', password: 'corta' }), (e: ErrorAuth) => e.codigo === 'clave_debil');
    await assert.rejects(auth.crear({ email: 'no-es-correo', nombre: 'X', rol: 'equipo', password: 'una-clave-larga' }), (e: ErrorAuth) => e.codigo === 'datos_invalidos');
    assert.equal(llamadas.length, 0);
  });
  it('no toma una cuenta que ya existe en el proyecto (de otra app)', async () => {
    const { auth, equipo } = await armar();
    await assert.rejects(auth.crear({ email: 'otra@app.cl', nombre: 'X', rol: 'equipo', password: 'una-clave-larga' }), (e: ErrorAuth) => e.codigo === 'correo_ya_registrado');
    assert.equal((await equipo.list()).length, 2);
  });
  it('si falla el registro en equipo, borra la cuenta recién creada', async () => {
    const { auth, equipo, llamadas } = await armar();
    equipo.insert = async () => { throw new Error('boom'); };
    await assert.rejects(auth.crear({ email: 'x@estudio.cl', nombre: 'X', rol: 'equipo', password: 'una-clave-larga' }));
    assert.ok(llamadas.some((l) => l.startsWith('DELETE /auth/v1/admin/users/u-')));
  });
  it('sin service key no se puede crear', async () => {
    const equipo = createMemoryEquipoStore();
    const auth = createAutenticador({ url: 'https://x.supabase.co', publishableKey: 'pub' }, equipo, supabaseFalso().fetchFalso);
    await assert.rejects(auth.crear({ email: 'a@b.cl', nombre: 'X', rol: 'equipo', password: 'una-clave-larga' }), (e: ErrorAuth) => e.codigo === 'sin_service_key');
  });
});

describe('rutas del panel con Supabase Auth', () => {
  async function app() {
    const { auth } = await armar();
    const a = Fastify();
    const store = createFileStore(path.join(await mkdtemp(path.join(tmpdir(), 'sb-')), 'p.json'));
    await registerPanel(a, { store, clave: undefined, produccion: true, auth });
    const h = (t: string) => ({ authorization: `Bearer ${t}` });
    const clientes = (t?: string) => a.inject({ url: '/panel/api/docs/clientes', ...(t ? { headers: h(t) } : {}) });
    return { a, h, clientes };
  }
  const nueva = { email: 'nuevo@estudio.cl', nombre: 'Nuevo', rol: 'equipo', password: 'una-clave-larga' };

  it('el estado anuncia Supabase y solo expone la clave pública', async () => {
    const { a } = await app();
    const e = (await a.inject({ url: '/panel/api/estado' })).json();
    assert.equal(e.auth, 'supabase');
    assert.deepEqual(e.supabase, { url: 'https://x.supabase.co', publishableKey: 'pub' });
    assert.ok(!JSON.stringify(e).includes('service-secreta'));
  });

  it('401 sin sesión, 403 si no es del estudio, 200 si es miembro', async () => {
    const { clientes } = await app();
    assert.equal((await clientes()).statusCode, 401);
    assert.equal((await clientes('falso')).statusCode, 401);
    assert.equal((await clientes('tok-intruso')).statusCode, 403);
    assert.equal((await clientes('tok-beto')).statusCode, 200);
  });

  it('solo un administrador administra el equipo', async () => {
    const { a, h } = await app();
    assert.equal((await a.inject({ url: '/panel/api/equipo', headers: h('tok-beto') })).statusCode, 403);
    assert.equal((await a.inject({ method: 'POST', url: '/panel/api/equipo', headers: h('tok-beto'), payload: nueva })).statusCode, 403);
    assert.equal((await a.inject({ url: '/panel/api/equipo', headers: h('tok-ana') })).json().equipo.length, 2);
  });

  it('el admin crea una cuenta y la clave nunca vuelve en la respuesta', async () => {
    const { a, h } = await app();
    const post = (payload: object) => a.inject({ method: 'POST', url: '/panel/api/equipo', headers: h('tok-ana'), payload });
    const r = await post(nueva);
    assert.equal(r.statusCode, 201);
    assert.ok(!r.body.includes('una-clave-larga'));
    assert.equal((await post({ ...nueva, email: 'otra@app.cl' })).statusCode, 409);
    assert.equal((await post({ ...nueva, email: 'a@b.cl', password: 'corta' })).statusCode, 400);
  });

  it('desactivar a alguien le corta el acceso de inmediato, y un admin no puede quitarse el suyo', async () => {
    const { a, h, clientes } = await app();
    const patch = (id: string, payload: object) => a.inject({ method: 'PATCH', url: `/panel/api/equipo/${id}`, headers: h('tok-ana'), payload });
    assert.equal((await clientes('tok-beto')).statusCode, 200);
    assert.equal((await patch('u-beto', { activo: false })).statusCode, 204);
    assert.equal((await clientes('tok-beto')).statusCode, 403);
    assert.equal((await patch('u-ana', { activo: false })).statusCode, 400);
    assert.equal((await patch('u-ana', { rol: 'equipo' })).statusCode, 400);
    assert.equal((await patch('u-zzz', { activo: false })).statusCode, 404);
  });
});
