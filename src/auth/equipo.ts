/**
 * Quién del estudio puede entrar al panel. La identidad (correo y clave) la lleva
 * Supabase Auth; esta tabla decide el ACCESO: una cuenta de Auth que no figure aquí
 * y activa no entra, aunque su sesión sea válida (ver migrations/0004_equipo.sql).
 */

export type Rol = 'admin' | 'equipo';

export interface Miembro {
  userId: string;
  email: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
}

export interface EquipoStore {
  get(userId: string): Promise<Miembro | undefined>;
  list(): Promise<Miembro[]>;
  insert(m: Miembro): Promise<void>;
  update(userId: string, cambios: Partial<Pick<Miembro, 'rol' | 'activo' | 'nombre'>>): Promise<void>;
  remove(userId: string): Promise<void>;
}

export function createMemoryEquipoStore(): EquipoStore {
  const m = new Map<string, Miembro>();
  return {
    async get(id) {
      return m.get(id);
    },
    async list() {
      return [...m.values()];
    },
    async insert(x) {
      if ([...m.values()].some((y) => y.email === x.email)) throw new Error('correo_duplicado');
      m.set(x.userId, { ...x });
    },
    async update(id, c) {
      const x = m.get(id);
      if (x) m.set(id, { ...x, ...c });
    },
    async remove(id) {
      m.delete(id);
    },
  };
}

interface Fila {
  user_id: string;
  email: string;
  nombre: string;
  rol: Rol;
  activo: boolean;
}
const aMiembro = (f: Fila): Miembro => ({ userId: f.user_id, email: f.email, nombre: f.nombre, rol: f.rol, activo: f.activo });

/** Tabla `equipo` (migrations/0004_equipo.sql). */
export async function createPostgresEquipoStore(): Promise<EquipoStore> {
  const { query } = await import('../db/client.js');
  return {
    async get(id) {
      const r = await query<Fila>('SELECT user_id, email, nombre, rol, activo FROM equipo WHERE user_id = $1', [id]);
      return r.rows[0] ? aMiembro(r.rows[0]) : undefined;
    },
    async list() {
      const r = await query<Fila>('SELECT user_id, email, nombre, rol, activo FROM equipo ORDER BY nombre');
      return r.rows.map(aMiembro);
    },
    async insert(x) {
      await query('INSERT INTO equipo (user_id, email, nombre, rol, activo) VALUES ($1, $2, $3, $4, $5)', [x.userId, x.email, x.nombre, x.rol, x.activo]);
    },
    async update(id, c) {
      // COALESCE: solo cambia lo que viene; un campo ausente no se pisa con NULL.
      await query('UPDATE equipo SET rol = COALESCE($2, rol), activo = COALESCE($3, activo), nombre = COALESCE($4, nombre) WHERE user_id = $1', [
        id,
        c.rol ?? null,
        c.activo ?? null,
        c.nombre ?? null,
      ]);
    },
    async remove(id) {
      await query('DELETE FROM equipo WHERE user_id = $1', [id]);
    },
  };
}
