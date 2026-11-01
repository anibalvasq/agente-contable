import { cifrar, descifrar, leerLlave } from '../security/vault.js';

/**
 * Almacén de claves de las empresas. Solo guarda y entrega claves a código del
 * servidor (el futuro robot de los procesos 8 y 9): no hay ruta HTTP ni
 * herramienta del agente que devuelva una clave, a propósito. Un LLM que puede
 * leer claves es un LLM al que alguien puede pedirle que las diga.
 */

export const SISTEMAS = ['sii', 'previred', 'defontana'] as const;
export type Sistema = (typeof SISTEMAS)[number];

/** Dónde quedan los textos YA cifrados. Nunca ve una clave en claro. */
export interface CredentialStore {
  put(rut: string, sistema: Sistema, cifrada: string): Promise<void>;
  get(rut: string, sistema: Sistema): Promise<string | undefined>;
  /** Qué sistemas tienen clave guardada para cada RUT (sin las claves). */
  listar(): Promise<Array<{ rut: string; sistema: Sistema }>>;
}

export function createMemoryCredentialStore(): CredentialStore {
  const m = new Map<string, string>();
  const k = (rut: string, s: Sistema) => `${rut}|${s}`;
  return {
    async put(rut, s, c) {
      m.set(k(rut, s), c);
    },
    async get(rut, s) {
      return m.get(k(rut, s));
    },
    async listar() {
      return [...m.keys()].map((x) => {
        const [rut, sistema] = x.split('|') as [string, Sistema];
        return { rut, sistema };
      });
    },
  };
}

export async function createPostgresCredentialStore(): Promise<CredentialStore> {
  const { query } = await import('../db/client.js');
  return {
    async put(rut, sistema, cifrada) {
      await query(
        `INSERT INTO empresa_credenciales (rut, sistema, clave_cifrada, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (rut, sistema) DO UPDATE SET clave_cifrada = EXCLUDED.clave_cifrada, updated_at = now()`,
        [rut, sistema, cifrada],
      );
    },
    async get(rut, sistema) {
      const r = await query<{ clave_cifrada: string }>(
        'SELECT clave_cifrada FROM empresa_credenciales WHERE rut = $1 AND sistema = $2',
        [rut, sistema],
      );
      return r.rows[0]?.clave_cifrada;
    },
    async listar() {
      const r = await query<{ rut: string; sistema: Sistema }>('SELECT rut, sistema FROM empresa_credenciales ORDER BY rut, sistema');
      return r.rows;
    },
  };
}

export interface Vault {
  guardar(rut: string, sistema: Sistema, clave: string): Promise<void>;
  /** Para el robot. undefined si esa empresa no tiene clave guardada. */
  obtener(rut: string, sistema: Sistema): Promise<string | undefined>;
  listar(): Promise<Array<{ rut: string; sistema: Sistema }>>;
}

/** El AAD ata la clave cifrada a su fila: ver security/vault.ts. */
const aad = (rut: string, sistema: Sistema) => `${rut}|${sistema}`;

export function createVault(store: CredentialStore, llaveBase64: string | undefined): Vault {
  // Se valida al crear: mejor que el script muera de entrada que a mitad de la importación.
  const llave = leerLlave(llaveBase64);
  return {
    async guardar(rut, sistema, clave) {
      await store.put(rut, sistema, cifrar(clave, llave, aad(rut, sistema)));
    },
    async obtener(rut, sistema) {
      const c = await store.get(rut, sistema);
      return c === undefined ? undefined : descifrar(c, llave, aad(rut, sistema));
    },
    listar: () => store.listar(),
  };
}
