import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { createFileStore } from '../panel/store.js';
import { registerMcp } from './server.js';

const TOKEN = 'un-token-de-prueba-bien-largo-123';
const HEADERS = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

// null = sin token (un `undefined` activaría el valor por defecto).
async function armar(token: string | null = TOKEN) {
  const store = createFileStore(path.join(await mkdtemp(path.join(tmpdir(), 'mcp-')), 'p.json'));
  await store.put('empresas', 'emp_761234560', {
    id: 'emp_761234560', rut: '76123456-0', rutValido: true, nombre: 'Aromos Ltda.', encargado: 'Javier',
    f29: true, previred: true, remuneraciones: false, correos: ['a@aromos.cl'],
  });
  const app = Fastify();
  await registerMcp(app, { store, token: token ?? undefined });
  const rpc = (method: string, params: object = {}, headers = HEADERS) =>
    app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method, params } });
  return { app, rpc };
}

describe('servidor MCP', () => {
  it('sin MCP_TOKEN no existe la ruta', async () => {
    const { rpc } = await armar(null);
    assert.equal((await rpc('tools/list')).statusCode, 404);
  });

  it('exige el token', async () => {
    const { rpc } = await armar();
    assert.equal((await rpc('tools/list', {}, { ...HEADERS, authorization: 'Bearer otro' })).statusCode, 401);
    assert.equal((await rpc('tools/list', {}, { ...HEADERS, authorization: '' })).statusCode, 401);
  });

  it('lista solo herramientas de lectura y ninguna toca claves', async () => {
    const { rpc } = await armar();
    const r = await rpc('tools/list');
    assert.equal(r.statusCode, 200);
    const tools = r.json().result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    assert.deepEqual(tools.map((t) => t.name).sort(), ['clasificar_correo', 'consultar_vencimientos', 'listar_empresas', 'recordatorios_del_mes']);
    assert.ok(tools.every((t) => t.annotations.readOnlyHint === true));
    assert.ok(!/clave|password|credencial/i.test(JSON.stringify(tools.map((t) => t.name))));
  });

  it('ejecuta una herramienta con la base del estudio', async () => {
    const { rpc } = await armar();
    const r = await rpc('tools/call', { name: 'recordatorios_del_mes', arguments: { mes: '2026-11' } });
    const datos = JSON.parse(r.json().result.content[0].text);
    assert.equal(datos.recordatorios.length, 4);
    assert.equal(datos.recordatorios[0].cuerpo, undefined);
    const c = await rpc('tools/call', { name: 'clasificar_correo', arguments: { de: 'a@aromos.cl', asunto: 'Finiquito', cuerpo: 'calcular' } });
    assert.equal(JSON.parse(c.json().result.content[0].text).destino.clave, 'aquiles');
  });
});
