/**
 * Arma la base de empresas desde las tres planillas (exportadas a CSV) y la
 * guarda en el panel (colección `empresas`).
 *
 *   npm run empresas:importar -- --f29=f29.csv --previred=previred.csv --contactos=contactos.csv [--simular]
 *
 * La hoja F29 trae claves en texto simple: este script no las lee. Para
 * guardarlas cifradas usa `npm run claves:importar`.
 */
import { readFile } from 'node:fs/promises';
import { armarEmpresas } from '../src/empresas/empresas.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const [f29, previred, contactos] = ['f29', 'previred', 'contactos'].map(flag);
if (!f29 || !previred || !contactos) {
  console.error('Uso: npm run empresas:importar -- --f29=f29.csv --previred=previred.csv --contactos=contactos.csv [--simular]');
  process.exit(1);
}

const { empresas, avisos } = armarEmpresas({
  f29: await readFile(f29, 'utf8'),
  previred: await readFile(previred, 'utf8'),
  contactos: await readFile(contactos, 'utf8'),
});

const n = (f: (e: (typeof empresas)[number]) => boolean) => empresas.filter(f).length;
console.log(`${empresas.length} empresas: ${n((e) => e.f29)} con F29, ${n((e) => e.previred)} con Previred, ${n((e) => e.correos.length > 0)} con correo.`);
if (avisos.length) console.log(`\nPara revisar (${avisos.length}):\n` + avisos.map((a) => `  - ${a}`).join('\n'));

if (args.includes('--simular')) {
  console.log('\n[simulación] No se guardó nada.');
  process.exit(0);
}

const { createPanelStore } = await import('../src/panel/store.js');
await (await createPanelStore()).putMany('empresas', empresas);
console.log('\nGuardadas en el panel (colección empresas).');
process.exit(0);
