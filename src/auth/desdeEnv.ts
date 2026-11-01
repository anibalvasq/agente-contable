import { env } from '../env.js';
import { createPostgresEquipoStore } from './equipo.js';
import { createAutenticador, type Autenticador } from './supabase.js';

/** Supabase Auth si está configurado (SUPABASE_URL + clave pública); si no, undefined y el panel usa PANEL_PASSWORD. */
export async function crearAutenticadorDesdeEnv(): Promise<Autenticador | undefined> {
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return undefined;
  return createAutenticador(
    { url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, ...(env.SUPABASE_SERVICE_ROLE_KEY ? { serviceKey: env.SUPABASE_SERVICE_ROLE_KEY } : {}) },
    await createPostgresEquipoStore(),
  );
}
