import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Cifrado de las claves de las empresas (SII, Previred, Defontana).
 *
 * AES-256-GCM: cifra y además detecta si alguien tocó el dato guardado. La
 * llave vive en CREDENTIALS_KEY (variable de entorno), nunca en el repo ni en la
 * base: quien robe un respaldo de Postgres se lleva texto ilegible.
 *
 * Cada clave se cifra con un IV nuevo, y el RUT+sistema viaja como dato
 * autenticado (AAD). Sin eso, alguien con acceso de escritura a la tabla podría
 * copiar la clave cifrada de una empresa a otra y GCM la descifraría igual; con
 * el AAD, descifrar fuera de su fila falla.
 *
 * Formato guardado: `v1.<iv>.<tag>.<cifrado>`, todo en base64url. El prefijo de
 * versión deja rotar la llave o el algoritmo sin romper lo ya guardado.
 */

const VERSION = 'v1';
const ALGORITMO = 'aes-256-gcm';

/** Llave nueva lista para pegar en CREDENTIALS_KEY. */
export function generarLlave(): string {
  return randomBytes(32).toString('base64');
}

/** Valida y decodifica CREDENTIALS_KEY. Falla con un mensaje que dice cómo arreglarlo. */
export function leerLlave(valor: string | undefined): Buffer {
  if (!valor) {
    throw new Error('Falta CREDENTIALS_KEY. Genera una con: npm run claves:importar -- --generar-llave');
  }
  const llave = Buffer.from(valor, 'base64');
  if (llave.length !== 32) {
    throw new Error('CREDENTIALS_KEY debe ser de 32 bytes en base64 (genera una con --generar-llave).');
  }
  return llave;
}

export function cifrar(plano: string, llave: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv(ALGORITMO, llave, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const cifrado = Buffer.concat([c.update(plano, 'utf8'), c.final()]);
  const partes = [iv, c.getAuthTag(), cifrado].map((b) => b.toString('base64url'));
  return [VERSION, ...partes].join('.');
}

export function descifrar(token: string, llave: Buffer, aad: string): string {
  const [version, iv, tag, cifrado] = token.split('.');
  if (version !== VERSION || !iv || !tag || cifrado === undefined) throw new Error('formato_de_clave_desconocido');
  const d = createDecipheriv(ALGORITMO, llave, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  // Si la llave es otra o el dato fue alterado, final() lanza: no devuelve basura.
  return Buffer.concat([d.update(Buffer.from(cifrado, 'base64url')), d.final()]).toString('utf8');
}
