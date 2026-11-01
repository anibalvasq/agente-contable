import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';

/**
 * Única función de Vercel: todo el tráfico entra aquí (ver "rewrites" en
 * vercel.json) y se lo pasamos a Fastify. La app se arma una vez por instancia
 * y se reutiliza mientras la instancia siga caliente.
 *
 * El import de la app es dinámico a propósito: si la configuración es inválida
 * (una variable de entorno que falta, la URL de la base mal escrita), el error
 * salta al importar. Con un import estático la función moriría antes de entrar
 * al handler y Vercel mostraría un 500 sin explicación. Así lo capturamos.
 */
let app: Promise<FastifyInstance> | undefined;

async function construir(): Promise<FastifyInstance> {
  const { buildPanelApp } = await import('../src/vercel.js');
  const a = await buildPanelApp();
  await a.ready();
  return a;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    app ??= construir();
    (await app).server.emit('request', req, res);
  } catch (err) {
    app = undefined; // la próxima petición vuelve a intentarlo (p. ej. tras corregir una variable)
    console.error('no se pudo arrancar el panel', err);
    // El detalle (nombres de variables inválidas, no sus valores) solo se muestra fuera de producción:
    // en la URL pública no se le cuenta a un desconocido cómo está configurado el servidor.
    const detalle = process.env.VERCEL_ENV === 'production' ? 'error de configuración del servidor' : err instanceof Error ? err.message : String(err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'no_se_pudo_arrancar', detalle }));
  }
}
