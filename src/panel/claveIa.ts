import { cifrar, descifrar } from '../security/vault.js';
import { ErrorAnthropic, llamarAnthropic, type PeticionAnthropic, type RespuestaAnthropic } from './anthropic.js';

/**
 * API key de Claude de cada persona (BYOK). La guarda cifrada (AES-256-GCM, la misma bóveda de las
 * claves de empresas) y SOLO código del servidor la descifra, dentro de la request que la usa.
 * Ninguna ruta la devuelve: al navegador llegan los últimos 4 caracteres y el estado.
 */

export type EstadoClave = 'activa' | 'invalida';

export interface FilaClave {
  cifrada: string;
  ultimos4: string;
  estado: EstadoClave;
}

export interface ClaveStore {
  get(userId: string): Promise<FilaClave | undefined>;
  put(userId: string, fila: FilaClave): Promise<void>;
  setEstado(userId: string, estado: EstadoClave): Promise<void>;
  remove(userId: string): Promise<void>;
}

export type EstadoParaPanel = { estado: 'sin_clave' } | { estado: EstadoClave; ultimos4: string };

export class ErrorClave extends Error {
  constructor(readonly codigo: 'sin_clave' | 'clave_invalida' | 'formato_invalido' | 'clave_rechazada' | 'sin_saldo' | 'no_se_pudo_verificar') {
    super(codigo);
  }
}

// Las keys de la Console empiezan con "sk-ant-" (p. ej. sk-ant-api03-…). El largo mínimo descarta pegados a medias.
const FORMATO = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** El user_id va como dato autenticado: la fila de una persona no descifra bajo otra. */
const aad = (userId: string): string => `claveia:${userId}`;

export interface ClaveIaService {
  estado(userId: string): Promise<EstadoParaPanel>;
  /** Valida el formato, la prueba con una llamada mínima y solo entonces la cifra y guarda. */
  guardar(userId: string, clave: string): Promise<EstadoParaPanel>;
  eliminar(userId: string): Promise<void>;
  /** La key descifrada, para usarla en esta request. Lanza ErrorClave si falta o no sirve. */
  usar(userId: string): Promise<string>;
  marcarInvalida(userId: string): Promise<void>;
}

export interface ClaveIaOpts {
  store: ClaveStore;
  llave: Buffer;
  modelo: string;
  /** Se inyecta para testear sin red. */
  llamar?: (apiKey: string, p: PeticionAnthropic) => Promise<RespuestaAnthropic>;
}

export function createClaveIaService({ store, llave, modelo, llamar = (k, p) => llamarAnthropic(k, p) }: ClaveIaOpts): ClaveIaService {
  return {
    async estado(userId) {
      const f = await store.get(userId);
      return f ? { estado: f.estado, ultimos4: f.ultimos4 } : { estado: 'sin_clave' };
    },

    async guardar(userId, claveCruda) {
      const clave = claveCruda.trim();
      if (!FORMATO.test(clave)) throw new ErrorClave('formato_invalido');
      try {
        // max_tokens mínimo: comprueba que la key funciona sin gastar casi nada.
        await llamar(clave, { model: modelo, max_tokens: 1, messages: [{ role: 'user', content: 'hola' }] });
      } catch (err) {
        if (err instanceof ErrorAnthropic) {
          if (err.tipo === 'clave_invalida') throw new ErrorClave('clave_rechazada');
          if (err.tipo === 'sin_saldo') throw new ErrorClave('sin_saldo');
        }
        throw new ErrorClave('no_se_pudo_verificar');
      }
      const fila: FilaClave = { cifrada: cifrar(clave, llave, aad(userId)), ultimos4: clave.slice(-4), estado: 'activa' };
      await store.put(userId, fila);
      return { estado: 'activa', ultimos4: fila.ultimos4 };
    },

    async eliminar(userId) {
      await store.remove(userId);
    },

    async usar(userId) {
      const f = await store.get(userId);
      if (!f) throw new ErrorClave('sin_clave');
      if (f.estado === 'invalida') throw new ErrorClave('clave_invalida');
      try {
        return descifrar(f.cifrada, llave, aad(userId));
      } catch {
        // Llave rotada o fila alterada: no hay forma de usarla, la persona tiene que volver a pegarla.
        await store.setEstado(userId, 'invalida');
        throw new ErrorClave('clave_invalida');
      }
    },

    async marcarInvalida(userId) {
      await store.setEstado(userId, 'invalida');
    },
  };
}

export function createMemoryClaveStore(): ClaveStore {
  const m = new Map<string, FilaClave>();
  return {
    async get(id) {
      const f = m.get(id);
      return f ? { ...f } : undefined;
    },
    async put(id, f) {
      m.set(id, { ...f });
    },
    async setEstado(id, estado) {
      const f = m.get(id);
      if (f) m.set(id, { ...f, estado });
    },
    async remove(id) {
      m.delete(id);
    },
  };
}

interface Fila {
  clave_cifrada: string;
  ultimos4: string;
  estado: EstadoClave;
}

/** Tabla `claves_ia` (migrations/0005_claves_ia.sql). Toda consulta filtra por el user_id de la sesión. */
export async function createPostgresClaveStore(): Promise<ClaveStore> {
  const { query } = await import('../db/client.js');
  return {
    async get(id) {
      const r = await query<Fila>('SELECT clave_cifrada, ultimos4, estado FROM claves_ia WHERE user_id = $1', [id]);
      const f = r.rows[0];
      return f ? { cifrada: f.clave_cifrada, ultimos4: f.ultimos4, estado: f.estado } : undefined;
    },
    async put(id, f) {
      await query(
        `INSERT INTO claves_ia (user_id, clave_cifrada, ultimos4, estado) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET clave_cifrada = EXCLUDED.clave_cifrada, ultimos4 = EXCLUDED.ultimos4, estado = EXCLUDED.estado, actualizado = now()`,
        [id, f.cifrada, f.ultimos4, f.estado],
      );
    },
    async setEstado(id, estado) {
      await query('UPDATE claves_ia SET estado = $2, actualizado = now() WHERE user_id = $1', [id, estado]);
    },
    async remove(id) {
      await query('DELETE FROM claves_ia WHERE user_id = $1', [id]);
    },
  };
}
