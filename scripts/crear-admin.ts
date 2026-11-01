/**
 * Crea la primera cuenta de administrador del panel (Supabase Auth + tabla equipo).
 * Solo hace falta una vez: después los administradores crean al resto desde el panel.
 *
 *   npm run usuarios:crear-admin -- correo@estudio.cl "Nombre Apellido"
 *
 * Necesita SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SERVICE_ROLE_KEY y
 * DATABASE_URL (rol agente_contable_app) en el .env. Genera una clave temporal y la
 * muestra UNA vez en esta terminal: cámbiala al primer ingreso (Equipo → Cambiar mi clave).
 */
import { randomBytes } from 'node:crypto';

const [email, nombre] = process.argv.slice(2);
if (!email || !nombre) {
  console.error('Uso: npm run usuarios:crear-admin -- correo@estudio.cl "Nombre Apellido"');
  process.exit(1);
}

const { env } = await import('../src/env.js');
if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Faltan SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY o SUPABASE_SERVICE_ROLE_KEY en el .env.');
  process.exit(1);
}
const { createPostgresEquipoStore } = await import('../src/auth/equipo.js');
const { createAutenticador, ErrorAuth } = await import('../src/auth/supabase.js');
const { closePool } = await import('../src/db/client.js');

const auth = createAutenticador(
  { url: env.SUPABASE_URL, publishableKey: env.SUPABASE_PUBLISHABLE_KEY, serviceKey: env.SUPABASE_SERVICE_ROLE_KEY },
  await createPostgresEquipoStore(),
);
const temporal = randomBytes(12).toString('base64url');
try {
  const m = await auth.crear({ email, nombre, rol: 'admin', password: temporal });
  console.log(`Administrador creado: ${m.nombre} <${m.email}>`);
  console.log(`Clave temporal (se muestra una sola vez): ${temporal}`);
} catch (err) {
  console.error(err instanceof ErrorAuth ? err.message : err);
  process.exitCode = 1;
}
await closePool();
