import { cifrar, descifrar } from '../security/vault.js';
import { ErrorAnthropic, llamarAnthropic, type PeticionAnthropic, type RespuestaAnthropic } from './anthropic.js';

/**
 * API key de Claude del ESTUDIO: la configura un administrador y la usa el asistente del panel
 * para todo el equipo. Se cifra en cuanto llega al servidor (AES-256-GCM, la misma bóveda de las
 * claves de empresas) y solo código del servidor la descifra, dentro de la request que la usa.
 * Ninguna ruta la devuelve: al panel llegan el estado y los últimos 4 caracteres.
 */

export type EstadoClave = 'activa' | 'invalida';

export interface FilaClave {
  cifrada: string;
  ultimos4: string;
  estado: EstadoClave;
  /** Correo de quien la configuró. */
  por: string;
}

export interface ClaveStore {
  get(): Promise<FilaClave | undefined>;
  put(fila: FilaClave): Promise<void>;
  setEstado(estado: EstadoClave): Promise<void>;
  remove(): Promise<void>;
}

export type EstadoParaPanel = { estado: 'sin_clave' } | { estado: EstadoClave; ultimos4: string; por: string };

export class ErrorClave extends Error {
  constructor(readonly codigo: 'sin_clave' | 'clave_invalida' | 'formato_invalido' | 'clave_rechazada' | 'sin_saldo' | 'no_se_pudo_verificar') {
    super(codigo);
  }
}

// Las keys de la Console empiezan con "sk-ant-" (p. ej. sk-ant-api03-…). El largo mínimo descarta pegados a medias.
const FORMATO = /^sk-ant-[A-Za-z0-9_-]{20,}$/;

/** Dato autenticado del cifrado: una fila copiada a otro contexto no descifra. */
const AAD = 'claveia:estudio';

export interface ClaveIaService {
  estado(): Promise<EstadoParaPanel>;
  /** Valida el formato, la prueba con una llamada mínima y solo entonces la cifra y guarda. */
  guardar(clave: string, por: string): Promise<EstadoParaPanel>;
  eliminar(): Promise<void>;
  /** La key descifrada, para usarla en esta request. Lanza ErrorClave si falta o no sirve. */
  usar(): Promise<string>;
  marcarInvalida(): Promise<void>;
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
    async estado() {
      const f = await store.get();
      return f ? { estado: f.estado, ultimos4: f.ultimos4, por: f.por } : { estado: 'sin_clave' };
    },

    async guardar(claveCruda, por) {
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
      const fila: FilaClave = { cifrada: cifrar(clave, llave, AAD), ultimos4: clave.slice(-4), estado: 'activa', por };
      await store.put(fila);
      return { estado: 'activa', ultimos4: fila.ultimos4, por };
    },

    async eliminar() {
      await store.remove();
    },

    async usar() {
      const f = await store.get();
      if (!f) throw new ErrorClave('sin_clave');
      if (f.estado === 'invalida') throw new ErrorClave('clave_invalida');
      try {
        return descifrar(f.cifrada, llave, AAD);
      } catch {
        // Llave rotada o fila alterada: no hay forma de usarla, un administrador tiene que volver a pegarla.
        await store.setEstado('invalida');
        throw new ErrorClave('clave_invalida');
      }
    },

    async marcarInvalida() {
      await store.setEstado('invalida');
    },
  };
}

export function createMemoryClaveStore(): ClaveStore {
  let fila: FilaClave | undefined;
  return {
    async get() {
      return fila ? { ...fila } : undefined;
    },
    async put(f) {
      fila = { ...f };
    },
    async setEstado(estado) {
      if (fila) fila = { ...fila, estado };
    },
    async remove() {
      fila = undefined;
    },
  };
}

interface Fila {
  clave_cifrada: string;
  ultimos4: string;
  estado: EstadoClave;
  actualizado_por: string;
}

/** Tabla `clave_ia_estudio` (migrations/0006_clave_ia_estudio.sql): una sola fila. */
export async function createPostgresClaveStore(): Promise<ClaveStore> {
  const { query } = await import('../db/client.js');
  return {
    async get() {
      const r = await query<Fila>("SELECT clave_cifrada, ultimos4, estado, actualizado_por FROM clave_ia_estudio WHERE id = 'estudio'");
      const f = r.rows[0];
      return f ? { cifrada: f.clave_cifrada, ultimos4: f.ultimos4, estado: f.estado, por: f.actualizado_por } : undefined;
    },
    async put(f) {
      await query(
        `INSERT INTO clave_ia_estudio (id, clave_cifrada, ultimos4, estado, actualizado_por) VALUES ('estudio', $1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET clave_cifrada = EXCLUDED.clave_cifrada, ultimos4 = EXCLUDED.ultimos4, estado = EXCLUDED.estado,
           actualizado_por = EXCLUDED.actualizado_por, actualizado = now()`,
        [f.cifrada, f.ultimos4, f.estado, f.por],
      );
    },
    async setEstado(estado) {
      await query("UPDATE clave_ia_estudio SET estado = $1, actualizado = now() WHERE id = 'estudio'", [estado]);
    },
    async remove() {
      await query("DELETE FROM clave_ia_estudio WHERE id = 'estudio'");
    },
  };
}
