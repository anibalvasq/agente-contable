import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import { logger } from '../logger.js';
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
const COLECCIONES = new Set(['clientes', 'lotes']);
// Los ids los genera el panel (uid('cli') → "cli_lzx3k9ab1"). Nada de "/" ni "..".
const ID_VALIDO = /^[a-z]{2,10}_[a-z0-9]{4,40}$/;

export interface PanelOptions {
  store: PanelStore;
  /** PANEL_PASSWORD. Sin ella: libre en desarrollo, apagado en producción. */
  clave: string | undefined;
  produccion: boolean;
  /** Se inyecta para poder testear sin llamar al LLM. */
  responder?: (body: unknown) => Promise<unknown>;
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
      await store.put(col, id, body);
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { col: string; id: string } }>('/panel/api/docs/:col/:id', { preHandler: autorizar }, async (req, reply) => {
    const { col, id } = req.params;
    if (!COLECCIONES.has(col) || !ID_VALIDO.test(id)) return reply.code(400).send({ error: 'ruta inválida' });
    await store.remove(col, id);
    return reply.code(204).send();
  });

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
