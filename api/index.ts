import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildPanelApp } from '../src/vercel.js';

/**
 * Única función de Vercel: todo el tráfico entra aquí (ver "rewrites" en
 * vercel.json) y se lo pasamos a Fastify. La app se arma una vez por instancia
 * y se reutiliza mientras la instancia siga caliente.
 */
let app: Promise<FastifyInstance> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  app ??= buildPanelApp().then(async (a) => {
    await a.ready();
    return a;
  });
  (await app).server.emit('request', req, res);
}
