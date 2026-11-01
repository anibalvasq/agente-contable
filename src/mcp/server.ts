import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { consultarVencimientosTool } from '../agent/tools/chile/tools.js';
import { hoyChile } from '../agent/tools/chile/calc.js';
import { clasificar } from '../correos/clasificar.js';
import { cargarReglas } from '../correos/reglas.js';
import type { Empresa } from '../empresas/empresas.js';
import { logger } from '../logger.js';
import type { PanelStore } from '../panel/store.js';
import { armarPlan } from '../recordatorios/plan.js';

/**
 * Servidor MCP del estudio: deja que el cliente use SU propio Claude (claude.ai,
 * Claude Desktop o Claude Code) con las herramientas del panel. La IA corre en
 * su cuenta y con sus límites; este servidor solo entrega datos y cálculos.
 *
 * Reglas de este módulo:
 *  - Todas las herramientas son de SOLO LECTURA. Ninguna envía correos ni cambia
 *    la base: un Claude conectado desde afuera no debe poder actuar, solo consultar.
 *  - Ninguna devuelve claves. La bóveda (src/credentials) no se importa aquí, a propósito.
 *  - Los resultados son datos, nunca instrucciones para el modelo.
 */

const SOLO_LECTURA = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const ok = (datos: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(datos) }] });
const mesSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'formato AAAA-MM');

export function crearServidorMcp(store: PanelStore): McpServer {
  const server = new McpServer({ name: 'estudio-contable', version: '0.1.0' });
  const empresas = async () => (await store.list('empresas')) as Empresa[];

  server.registerTool(
    'consultar_vencimientos',
    {
      description:
        'Fechas de vencimiento del F29 (IVA y PPM) de un período tributario, con los días que faltan desde hoy. ' +
        'Si no se indica período, usa el mes anterior. No considera feriados.',
      inputSchema: { periodo: mesSchema.optional().describe("Período tributario 'AAAA-MM' (el mes que se declara)") },
      annotations: SOLO_LECTURA,
    },
    async ({ periodo }) => ok(await consultarVencimientosTool.run({ ...(periodo ? { periodo } : {}) }, {} as never)),
  );

  server.registerTool(
    'recordatorios_del_mes',
    {
      description:
        'Lista de recordatorios de F29 y Previred de un mes: qué empresa recibe qué aviso, qué día y a qué correos, ' +
        'más las alertas (empresas sin correo o sin encargado). Solo calcula la lista; no envía nada. ' +
        'El texto de los correos es provisorio.',
      inputSchema: {
        mes: mesSchema.optional().describe('Mes de vencimiento AAAA-MM. Por defecto, el mes actual.'),
        solo_pendientes: z.boolean().optional().describe('Solo avisos cuya fecha aún no pasa.'),
      },
      annotations: SOLO_LECTURA,
    },
    async ({ mes, solo_pendientes }) => {
      const hoy = hoyChile();
      const plan = armarPlan(await empresas(), { mes: mes ?? hoy.slice(0, 7), hoy });
      const lista = plan.recordatorios
        .filter((r) => !solo_pendientes || r.pendiente)
        // Sin el cuerpo del correo: es provisorio y repetido; ocupa contexto sin aportar.
        .map(({ cuerpo: _cuerpo, ...r }) => r);
      return ok({ mes: plan.mes, plantillaProvisoria: plan.plantillaProvisoria, vencimientos: plan.vencimientos, recordatorios: lista, alertas: plan.alertas });
    },
  );

  server.registerTool(
    'listar_empresas',
    {
      description: 'Empresas de la base del estudio (RUT, nombre, encargado, obligaciones y correos). Máximo 100 por consulta.',
      inputSchema: {
        filtro: z.enum(['f29', 'previred', 'sin_correo', 'sin_encargado']).optional(),
        texto: z.string().max(100).optional().describe('Parte del nombre o del RUT.'),
      },
      annotations: SOLO_LECTURA,
    },
    async ({ filtro, texto }) => {
      const t = texto?.toLowerCase().trim();
      const todas = await empresas();
      const lista = todas
        .filter((e) => (filtro === 'f29' ? e.f29 : filtro === 'previred' ? e.previred : filtro === 'sin_correo' ? !e.correos.length : filtro === 'sin_encargado' ? !e.encargado : true))
        .filter((e) => !t || e.nombre.toLowerCase().includes(t) || e.rut.includes(t));
      return ok({ total: lista.length, empresas: lista.slice(0, 100) });
    },
  );

  server.registerTool(
    'clasificar_correo',
    {
      description:
        'Aplica las reglas del estudio a un correo y dice a qué persona se deriva y por qué, con las dudas que una persona debería revisar. ' +
        'No envía ni responde nada.',
      inputSchema: {
        de: z.string().max(320),
        asunto: z.string().max(500),
        cuerpo: z.string().max(20_000),
      },
      annotations: SOLO_LECTURA,
    },
    async (correo) => {
      const { reglas } = await cargarReglas(store);
      return ok(clasificar(correo, await empresas(), reglas));
    },
  );

  return server;
}

/** Compara en tiempo constante; hashear antes iguala los largos. */
function mismoToken(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/**
 * Publica POST /mcp. Sin MCP_TOKEN queda apagado (404): un endpoint con los datos
 * del estudio no puede quedar abierto por olvido.
 *
 * Modo sin estado: cada request arma su servidor y transporte. Las herramientas son
 * de lectura y no necesitan sesión, y así no hay nada que se pierda en un redeploy.
 */
export async function registerMcp(app: FastifyInstance, opts: { store: PanelStore; token: string | undefined }): Promise<void> {
  const { store, token } = opts;
  if (!token) {
    logger.info('MCP apagado: define MCP_TOKEN para habilitar /mcp');
    return;
  }
  logger.info('MCP habilitado en /mcp');

  app.post('/mcp', async (req, reply) => {
    const h = req.headers.authorization ?? '';
    const enviado = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!enviado || !mismoToken(enviado, token)) return reply.code(401).send({ error: 'token inválido' });

    const server = crearServidorMcp(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      reply.hijack();
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      logger.error({ err }, 'falló una llamada MCP');
      if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'error interno' }));
    }
  });

  // Sin sesiones ni stream de notificaciones: GET y DELETE no aplican.
  const noPermitido = async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => reply.code(405).send({ error: 'usa POST' });
  app.get('/mcp', noPermitido);
  app.delete('/mcp', noPermitido);
}
