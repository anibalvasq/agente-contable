import { env } from '../env.js';
import { logger } from '../logger.js';
import { leerLlave } from '../security/vault.js';
import { createClaveIaService, createMemoryClaveStore, createPostgresClaveStore, type ClaveIaService } from './claveIa.js';

/**
 * La key de Claude de cada persona solo tiene sentido con cuentas reales (Supabase Auth): sin ellas
 * no hay "quién pregunta" y el asistente sigue con el LLM del estudio. Necesita CREDENTIALS_KEY
 * para cifrar; sin ella el asistente por persona no se enciende (y se avisa, no se cae el panel).
 */
export async function crearClaveIaDesdeEnv(hayAuth: boolean): Promise<ClaveIaService | undefined> {
  if (!hayAuth) return undefined;
  let llave: Buffer;
  try {
    llave = leerLlave(env.CREDENTIALS_KEY);
  } catch (err) {
    // No tumba el panel entero por esto; el asistente sigue con el LLM del estudio hasta que se defina la llave.
    logger.warn({ motivo: err instanceof Error ? err.message : 'llave inválida' }, 'sin CREDENTIALS_KEY válida: las personas no pueden guardar su API key de Claude');
    return undefined;
  }
  return createClaveIaService({
    store: env.STORE === 'postgres' ? await createPostgresClaveStore() : createMemoryClaveStore(),
    llave,
    modelo: env.ANTHROPIC_MODEL,
  });
}
