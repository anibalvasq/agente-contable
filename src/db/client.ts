import pg from 'pg';
import { env } from '../env.js';
import { logger } from '../logger.js';

const { Pool } = pg;

// Solo se importa cuando STORE=postgres, y en ese caso env.ts ya garantizó que
// DATABASE_URL existe (ver el .refine de env.ts).
if (!env.DATABASE_URL) {
  throw new Error('db/client.ts importado sin DATABASE_URL (¿STORE=postgres?)');
}

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  // En serverless (Vercel) cada instancia abre su propio pool: con 10 conexiones por instancia
  // se agota el pooler de Supabase en un pico. Una por instancia basta.
  max: process.env.VERCEL ? 1 : 10,
  // Supabase exige TLS. Sin verificar la cadena: su pooler firma con una CA propia que no está
  // en el almacén del sistema. Va cifrado igual; lo que se pierde es detectar un servidor falso.
  ...(env.DATABASE_SSL ? { ssl: { rejectUnauthorized: false } } : {}),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => logger.error({ err }, 'error inesperado en el pool de Postgres'));

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const result = await pool.query<T>(text, params as never[]);
  logger.debug({ ms: Date.now() - start, rows: result.rowCount }, 'sql');
  return result;
}

/** Primera fila o null. */
export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<T | null> {
  const result = await query<T>(text, params);
  return result.rows[0] ?? null;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
