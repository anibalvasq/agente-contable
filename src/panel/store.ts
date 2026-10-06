import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';

/**
 * Dónde guarda el panel sus clientes y lotes. Es un almacén de documentos
 * mínimo (colección + id → JSON), el mismo modelo que tenía el panel cuando
 * vivía como artifact de claude.ai, para no reescribir su lógica.
 *
 * Los Excel NO pasan por aquí: se leen en el navegador y quedan en su memoria.
 * Al servidor solo llegan los resúmenes (cuadre por cuenta, hallazgos, estado).
 */
export interface PanelStore {
  list(collection: string): Promise<unknown[]>;
  put(collection: string, id: string, data: unknown): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
}

/**
 * Archivo JSON en disco. Es el de STORE=memory, a pesar del nombre: si el
 * panel guardara en RAM, `npm run demo` (tsx watch) borraría los clientes cada
 * vez que guardas un .ts, porque reinicia el proceso.
 */
export function createFileStore(file: string): PanelStore {
  let cache: Record<string, Record<string, unknown>> | null = null;
  // Las escrituras van en fila. Dos PUT simultáneos que leen, modifican y
  // escriben el archivo a la vez se pisan: gana el último y el otro se pierde.
  let cola: Promise<unknown> = Promise.resolve();

  async function cargar(): Promise<Record<string, Record<string, unknown>>> {
    if (cache) return cache;
    try {
      cache = JSON.parse(await readFile(file, 'utf8')) as Record<string, Record<string, unknown>>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      cache = {};
    }
    return cache;
  }

  async function guardar(): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    // Escribir a un temporal y renombrar: si el proceso muere a mitad de la
    // escritura, queda el archivo anterior entero y no uno cortado que ya no
    // se puede parsear (y con él, todos los clientes perdidos).
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(cache), 'utf8');
    await rename(tmp, file);
  }

  function enFila<T>(fn: () => Promise<T>): Promise<T> {
    const p = cola.then(fn, fn);
    cola = p.catch(() => undefined);
    return p;
  }

  return {
    async list(collection) {
      const db = await cargar();
      return Object.values(db[collection] ?? {});
    },
    put(collection, id, data) {
      return enFila(async () => {
        const db = await cargar();
        (db[collection] ??= {})[id] = data;
        await guardar();
      });
    },
    remove(collection, id) {
      return enFila(async () => {
        const db = await cargar();
        if (db[collection]) delete db[collection][id];
        await guardar();
      });
    },
  };
}

/** Tabla panel_docs (migrations/0002_panel.sql). */
async function createPostgresStore(): Promise<PanelStore> {
  const { query } = await import('../db/client.js');
  return {
    async list(collection) {
      const r = await query<{ data: unknown }>('SELECT data FROM panel_docs WHERE collection = $1', [collection]);
      return r.rows.map((x) => x.data);
    },
    async put(collection, id, data) {
      await query(
        `INSERT INTO panel_docs (collection, id, data, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [collection, id, JSON.stringify(data)],
      );
    },
    async remove(collection, id) {
      await query('DELETE FROM panel_docs WHERE collection = $1 AND id = $2', [collection, id]);
    },
  };
}

export async function createPanelStore(): Promise<PanelStore> {
  if (env.STORE === 'postgres') return createPostgresStore();
  return createFileStore(path.resolve(process.cwd(), 'data', 'panel.json'));
}
