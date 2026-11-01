import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { hoyChile } from '../agent/tools/chile/calc.js';
import { cargarReglas, validarReglas } from '../correos/reglas.js';
import { procesarCorreo, type ResolverIA } from '../correos/procesar.js';
import type { Empresa } from '../empresas/empresas.js';
import { logger } from '../logger.js';
import { armarPlan, planACsv } from '../recordatorios/plan.js';
import type { PanelStore } from './store.js';

/**
 * Panel del estudio en /panel: clientes, lotes de comprobantes, cuadre por
 * cuenta y carga a Defontana. Lo usa el equipo, no los clientes de WhatsApp.
 *
 * Se registra con cualquier canal activo (no depende del canal web), porque
 * en producción el canal será WhatsApp y el panel tiene que seguir ahí.
 */

// Solo estas colecciones. Sin la lista, el endpoint sería un disco gratis
// para guardar lo que cualquiera quiera mandarle.
const COLECCIONES = new Set(['clientes', 'lotes', 'cuentas', 'centros', 'usuarios', 'empresas', 'reglas']);
// Tope de una importación. Un plan de cuentas real anda por las 300-800.
const MAX_LOTE = 3000;
// Los ids los genera el panel (uid('cli') → "cli_lzx3k9ab1"). Nada de "/" ni "..".
const ID_VALIDO = /^[a-z]{2,10}_[a-z0-9]{4,40}$/;

export interface PanelOptions {
  store: PanelStore;
  /** PANEL_PASSWORD. Sin ella: libre en desarrollo, apagado en producción. */
  clave: string | undefined;
  produccion: boolean;
  /** Se inyecta para poder testear sin llamar al LLM. */
  responder?: (body: unknown) => Promise<unknown>;
  /** Resolver de consultas simples del proceso 5. Sin él, esas consultas se derivan a una persona. */
  resolverCorreo?: ResolverIA;
}

/** Compara en tiempo constante. Hashear antes iguala los largos. */
function mismaClave(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function registerPanel(app: FastifyInstance, opts: PanelOptions): Promise<void> {
  const { store, clave, produccion } = opts;
  // Un panel con los datos contables de los clientes abierto en internet sin
  // clave es peor que no tener panel. En local da igual: solo lo ves tú.
  const habilitado = Boolean(clave) || !produccion;
  if (!habilitado) logger.warn('panel deshabilitado: falta PANEL_PASSWORD en producción');
  else {
    logger.info(`panel del estudio → http://localhost:${env.PORT}/panel`);
    if (!clave) logger.warn('panel SIN clave (solo desarrollo). Define PANEL_PASSWORD antes de desplegar');
  }

  const htmlPath = path.resolve(process.cwd(), 'panel', 'index.html');
  app.get('/panel', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/html; charset=utf-8').send(await readFile(htmlPath, 'utf8'));
  });

  // La raíz abre el panel: es lo que el equipo usa a diario.
  app.get('/', (_req, reply) => reply.redirect('/panel'));

  app.get('/panel/api/estado', async () => ({ habilitado, requiereClave: Boolean(clave) }));

  async function autorizar(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!habilitado) return reply.code(503).send({ error: 'panel deshabilitado' });
    if (!clave) return;
    const h = req.headers.authorization ?? '';
    const enviada = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!enviada || !mismaClave(enviada, clave)) return reply.code(401).send({ error: 'clave inválida' });
  }

  // El login no emite nada: solo le dice al navegador si la clave sirve, para
  // dar el error en la pantalla de ingreso y no a mitad de un guardado.
  app.post('/panel/api/login', { preHandler: autorizar }, async () => ({ ok: true }));

  app.get<{ Params: { col: string } }>('/panel/api/docs/:col', { preHandler: autorizar }, async (req, reply) => {
    if (!COLECCIONES.has(req.params.col)) return reply.code(404).send({ error: 'colección desconocida' });
    return { docs: await store.list(req.params.col) };
  });

  app.put<{ Params: { col: string; id: string } }>(
    '/panel/api/docs/:col/:id',
    // Un lote trae el cuadre por cuenta de cada mes y sus hallazgos: pasa de
    // largo el límite global de 256 KB pensado para webhooks.
    { preHandler: autorizar, bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      const { col, id } = req.params;
      if (!COLECCIONES.has(col) || !ID_VALIDO.test(id)) return reply.code(400).send({ error: 'ruta inválida' });
      const body = req.body as { id?: unknown } | null;
      if (!body || typeof body !== 'object' || Array.isArray(body) || body.id !== id) {
        return reply.code(400).send({ error: 'el documento debe ser un objeto con el mismo id de la ruta' });
      }
      if (col === 'reglas') {
        // Una regla mal escrita se rechaza aquí, no cuando llega un correo real.
        const v = validarReglas(body);
        if (!v.ok) return reply.code(400).send({ error: 'reglas inválidas', detalle: v.errores });
      }
      await store.put(col, id, body);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { col: string } }>(
    '/panel/api/docs/:col/_lote',
    { preHandler: autorizar, bodyLimit: 4 * 1024 * 1024 },
    async (req, reply) => {
      const { col } = req.params;
      if (!COLECCIONES.has(col)) return reply.code(400).send({ error: 'ruta inválida' });
      const docs = (req.body as { docs?: unknown } | null)?.docs;
      if (!Array.isArray(docs) || docs.length === 0 || docs.length > MAX_LOTE) {
        return reply.code(400).send({ error: `se esperan entre 1 y ${MAX_LOTE} documentos` });
      }
      const validos = docs.every(
        (d) => d && typeof d === 'object' && !Array.isArray(d) && typeof (d as { id?: unknown }).id === 'string' && ID_VALIDO.test((d as { id: string }).id),
      );
      if (!validos) return reply.code(400).send({ error: 'todos los documentos necesitan un id válido' });
      await store.putMany(col, docs as { id: string }[]);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { col: string; id: string } }>('/panel/api/docs/:col/:id', { preHandler: autorizar }, async (req, reply) => {
    const { col, id } = req.params;
    if (!COLECCIONES.has(col) || !ID_VALIDO.test(id)) return reply.code(400).send({ error: 'ruta inválida' });
    await store.remove(col, id);
    return reply.code(204).send();
  });

  // ── Proceso 4: lista de recordatorios del mes. Solo calcula; no envía nada. ──
  app.get<{ Querystring: { mes?: string; formato?: string; feriados?: string; corridos?: string } }>(
    '/panel/api/recordatorios',
    { preHandler: autorizar },
    async (req, reply) => {
      const hoy = hoyChile();
      const mes = req.query.mes ?? hoy.slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) return reply.code(400).send({ error: 'mes inválido (AAAA-MM)' });
      const feriados = (req.query.feriados ?? '').split(',').filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f));
      const empresas = (await store.list('empresas')) as Empresa[];
      const plan = armarPlan(empresas, { mes, hoy, feriados: new Set(feriados), modo: req.query.corridos === '1' ? 'corridos' : 'habiles' });
      if (req.query.formato === 'csv') {
        return reply.header('Content-Disposition', `attachment; filename="recordatorios-${mes}.csv"`).type('text/csv; charset=utf-8').send(planACsv(plan));
      }
      return plan;
    },
  );

  // ── Proceso 5: clasificación y derivación de correos por reglas. ──
  app.get('/panel/api/correos/reglas', { preHandler: autorizar }, async (_req, reply) => {
    try {
      return await cargarReglas(store);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'reglas inválidas' });
    }
  });

  app.post<{ Body: { de?: unknown; asunto?: unknown; cuerpo?: unknown; ia?: unknown } }>(
    '/panel/api/correos/clasificar',
    { preHandler: autorizar, bodyLimit: 256 * 1024 },
    async (req, reply) => {
      const { de, asunto, cuerpo } = req.body ?? {};
      if (typeof de !== 'string' || typeof asunto !== 'string' || typeof cuerpo !== 'string' || de.length > 320 || asunto.length > 500 || cuerpo.length > 50_000) {
        return reply.code(400).send({ error: 'se esperan de, asunto y cuerpo como texto' });
      }
      try {
        const { reglas } = await cargarReglas(store);
        const empresas = (await store.list('empresas')) as Empresa[];
        // La IA es opt-in por llamada: cada consulta simple cuesta una llamada al modelo.
        const resolver = req.body?.ia === true ? opts.resolverCorreo : undefined;
        return await procesarCorreo({ de, asunto, cuerpo }, empresas, reglas, resolver);
      } catch (err) {
        logger.error({ err }, 'no se pudo clasificar el correo');
        return reply.code(500).send({ error: err instanceof Error ? err.message : 'error al clasificar' });
      }
    },
  );

  app.post('/panel/api/asistente', { preHandler: autorizar, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { asistenteBody, responder } = await import('./assistant.js');
    const parsed = asistenteBody.safeParse(req.body);
    if (!parsed.success) {
      const grande = parsed.error.issues.some((i) => i.code === 'too_big');
      return reply.code(grande ? 413 : 400).send({ error: grande ? 'demasiados datos' : 'consulta inválida' });
    }
    try {
      return await (opts.responder ?? responder)(parsed.data);
    } catch (err) {
      logger.error({ err }, 'el asistente del panel falló');
      return reply.code(502).send({ error: 'el_modelo_fallo' });
    }
  });
}
