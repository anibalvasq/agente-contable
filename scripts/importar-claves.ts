/**
 * Importa a la bóveda cifrada las claves de la hoja de texto simple.
 *
 *   npm run claves:importar -- --generar-llave
 *   npm run claves:importar -- ruta/hoja-f29.csv --sistema=sii [--simular]
 *
 * La hoja se exporta a CSV desde Excel. Se leen dos columnas: el RUT y la
 * clave (encabezado que contenga "clave" o "password"). Nada más.
 *
 * El script NUNCA imprime una clave: solo cuántas guardó y de qué RUT faltan.
 * Cuando termine, borra el CSV (y la hoja original) de este equipo.
 */
import { readFile } from 'node:fs/promises';
import { createPostgresCredentialStore, createVault, SISTEMAS, type Sistema } from '../src/credentials/vault.js';
import { filasComoObjetos } from '../src/lib/csv.js';
import { normalizarRut } from '../src/lib/rut.js';
import { generarLlave } from '../src/security/vault.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];

if (args.includes('--generar-llave')) {
  console.log('Pega esta línea en tu .env (local) y en las variables de Coolify (producción):\n');
  console.log(`CREDENTIALS_KEY=${generarLlave()}\n`);
  console.log('Guárdala también en tu gestor de contraseñas: si la pierdes, las claves guardadas no se pueden recuperar.');
  process.exit(0);
}

const archivo = args.find((a) => !a.startsWith('--'));
const sistema = (flag('sistema') ?? 'sii') as Sistema;
if (!archivo || !SISTEMAS.includes(sistema)) {
  console.error(`Uso: npm run claves:importar -- <hoja.csv> --sistema=${SISTEMAS.join('|')} [--simular]`);
  process.exit(1);
}
// Import dinámico: --generar-llave tiene que funcionar antes de tener un .env completo.
const { env } = await import('../src/env.js');
if (env.STORE !== 'postgres' && !args.includes('--simular')) {
  console.error('Las claves solo se guardan en Postgres (STORE=postgres y DATABASE_URL). Usa --simular para probar el archivo.');
  process.exit(1);
}

const filas = filasComoObjetos(await readFile(archivo, 'utf8'));
const colRut = filas[0] && Object.keys(filas[0]).find((k) => k === 'rut' || k.startsWith('rut'));
const colClave = filas[0] && Object.keys(filas[0]).find((k) => k.includes('clave') || k.includes('password') || k.includes('contrasena'));
if (!colRut || !colClave) {
  console.error('No encontré las columnas: necesito una que empiece con "RUT" y otra con "Clave".');
  process.exit(1);
}

const simular = args.includes('--simular');
// En simulación no se necesita llave real ni base: solo se valida el archivo.
const vault = simular ? null : createVault(await createPostgresCredentialStore(), env.CREDENTIALS_KEY);

let guardadas = 0;
const sinClave: string[] = [];
const rutsMalos: string[] = [];
for (const f of filas) {
  const r = normalizarRut(f[colRut] ?? '');
  if (!r) {
    rutsMalos.push(f[colRut] || '(vacío)');
    continue;
  }
  const clave = f[colClave] ?? '';
  if (!clave) {
    sinClave.push(r.rut);
    continue;
  }
  if (!r.valido) rutsMalos.push(`${r.rut} (dígito verificador no coincide)`);
  await vault?.guardar(r.rut, sistema, clave);
  guardadas++;
}

console.log(`${simular ? '[simulación] ' : ''}${guardadas} claves de ${sistema} ${simular ? 'listas para guardar' : 'guardadas cifradas'}.`);
if (sinClave.length) console.log(`Sin clave (${sinClave.length}): ${sinClave.join(', ')}`);
if (rutsMalos.length) console.log(`RUT para revisar (${rutsMalos.length}): ${rutsMalos.join(', ')}`);
console.log('\nAhora borra el CSV y la hoja con las claves en texto simple de este equipo.');
process.exit(0);
