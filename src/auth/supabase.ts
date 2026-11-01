import { createHash } from 'node:crypto';
import type { EquipoStore, Miembro, Rol } from './equipo.js';

/**
 * Autenticación del panel con Supabase Auth.
 *
 * El navegador inicia sesión DIRECTO contra Supabase (correo + clave) y recibe un
 * access token. El servidor nunca ve la clave: solo recibe ese token, se lo pregunta
 * a Supabase (`/auth/v1/user`) y luego confirma que la persona figure como miembro
 * activo del estudio. Validar con una llamada a Supabase, en vez de verificar la firma
 * del JWT aquí, evita depender de cómo esté configurada la firma del proyecto (HS256 o
 * claves asimétricas) y hace que un usuario eliminado o con sesión cerrada deje de
 * valer apenas expire el caché corto.
 */

export interface SupabaseConfig {
  url: string;
  /** Clave pública (publishable/anon). Va al navegador a propósito. */
  publishableKey: string;
  /** Clave de administración. SOLO servidor: crea cuentas. Sin ella no se pueden crear usuarios. */
  serviceKey?: string;
}

export type Verificacion =
  | { estado: 'ok'; miembro: Miembro }
  /** Token vencido, falso o de una sesión cerrada. */
  | { estado: 'invalido' }
  /** La sesión es válida pero la persona no es (o ya no es) del estudio. */
  | { estado: 'sin_acceso' };

export interface NuevoMiembro {
  email: string;
  nombre: string;
  rol: Rol;
  password: string;
}

export class ErrorAuth extends Error {
  constructor(
    readonly codigo: 'correo_ya_registrado' | 'clave_debil' | 'sin_service_key' | 'datos_invalidos' | 'supabase_fallo',
    mensaje: string,
  ) {
    super(mensaje);
  }
}

export interface Autenticador {
  /** Lo que el navegador necesita para iniciar sesión. Nada secreto. */
  config: { url: string; publishableKey: string };
  equipo: EquipoStore;
  verificar(token: string): Promise<Verificacion>;
  crear(datos: NuevoMiembro): Promise<Miembro>;
  /** Saca de la caché a alguien cuyos permisos cambiaron, para que rija de inmediato. */
  olvidar(userId: string): void;
}

const TTL_MS = 30_000;
export const LARGO_MIN_CLAVE = 10;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createAutenticador(cfg: SupabaseConfig, equipo: EquipoStore, fetchFn: typeof fetch = fetch): Autenticador {
  const url = cfg.url.replace(/\/+$/, '');
  // token (hasheado: no guardamos el token en claro en memoria) → quién es y hasta cuándo vale el dato.
  const cache = new Map<string, { hasta: number; userId: string }>();

  const cabecerasAdmin = (): Record<string, string> => {
    if (!cfg.serviceKey) throw new ErrorAuth('sin_service_key', 'Falta SUPABASE_SERVICE_ROLE_KEY: no se pueden crear usuarios.');
    return { apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}`, 'Content-Type': 'application/json' };
  };

  async function usuarioDelToken(token: string): Promise<string | null> {
    const k = createHash('sha256').update(token).digest('hex');
    const c = cache.get(k);
    if (c && c.hasta > Date.now()) return c.userId;
    const r = await fetchFn(`${url}/auth/v1/user`, { headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${token}` } });
    if (!r.ok) {
      cache.delete(k);
      return null;
    }
    const u = (await r.json()) as { id?: unknown };
    if (typeof u.id !== 'string') return null;
    // Solo se guardan tokens válidos; el tope evita que la caché crezca sin límite.
    if (cache.size > 500) cache.clear();
    cache.set(k, { hasta: Date.now() + TTL_MS, userId: u.id });
    return u.id;
  }

  return {
    config: { url, publishableKey: cfg.publishableKey },
    equipo,

    async verificar(token) {
      const userId = await usuarioDelToken(token);
      if (!userId) return { estado: 'invalido' };
      const m = await equipo.get(userId);
      return m?.activo ? { estado: 'ok', miembro: m } : { estado: 'sin_acceso' };
    },

    async crear({ email, nombre, rol, password }) {
      const correo = email.trim().toLowerCase();
      if (!EMAIL.test(correo) || !nombre.trim() || !['admin', 'equipo'].includes(rol)) throw new ErrorAuth('datos_invalidos', 'Correo, nombre o rol inválidos.');
      if (password.length < LARGO_MIN_CLAVE) throw new ErrorAuth('clave_debil', `La clave debe tener al menos ${LARGO_MIN_CLAVE} caracteres.`);

      const r = await fetchFn(`${url}/auth/v1/admin/users`, {
        method: 'POST',
        headers: cabecerasAdmin(),
        // email_confirm: la cuenta la crea una persona de confianza del estudio, no hay
        // un correo de verificación que esperar.
        body: JSON.stringify({ email: correo, password, email_confirm: true, user_metadata: { nombre: nombre.trim() } }),
      });
      if (r.status === 422 || r.status === 409) {
        // El proyecto de Supabase es compartido: ese correo puede ser de una cuenta de OTRA
        // aplicación. No se le da acceso al estudio por tener la cuenta: la dueña de esa
        // cuenta no pidió entrar aquí, y la clave que escribimos no se aplicó.
        throw new ErrorAuth('correo_ya_registrado', 'Ya existe una cuenta con ese correo en el proyecto. Usa otro correo.');
      }
      if (!r.ok) throw new ErrorAuth('supabase_fallo', `Supabase respondió ${r.status} al crear la cuenta.`);
      const { id } = (await r.json()) as { id: string };

      const miembro: Miembro = { userId: id, email: correo, nombre: nombre.trim(), rol, activo: true };
      try {
        await equipo.insert(miembro);
      } catch (err) {
        // Sin fila en `equipo` la cuenta no entra, pero quedaría una cuenta huérfana que además
        // bloquea volver a crear ese correo. Se deshace.
        await fetchFn(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: cabecerasAdmin() }).catch(() => undefined);
        throw err;
      }
      return miembro;
    },

    olvidar(userId) {
      // El caché va por hash del token, no por usuario: se vacía completo (son pocas personas).
      void userId;
      cache.clear();
    },
  };
}
