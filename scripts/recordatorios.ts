/**
 * Lista de recordatorios del mes (qué empresa recibe qué aviso y cuándo).
 * NO envía nada.
 *
 *   npm run recordatorios -- [--mes=2026-11] [--csv=salida.csv] [--feriados=2026-12-08,2026-12-25] [--corridos]
 *
 * Sin --mes usa el mes actual (en Chile). Los feriados no se conocen solos:
 * pásalos con --feriados cuando el 13 o el 20 estén cerca de uno.
 */
import { writeFile } from 'node:fs/promises';
import { hoyChile } from '../src/agent/tools/chile/calc.js';
import type { Empresa } from '../src/empresas/empresas.js';
import { createPanelStore } from '../src/panel/store.js';
import { armarPlan, planACsv, planATexto } from '../src/recordatorios/plan.js';

const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

const hoy = hoyChile();
const mes = flag('mes') ?? hoy.slice(0, 7);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(mes)) {
  console.error('--mes debe ser AAAA-MM, por ejemplo 2026-11');
  process.exit(1);
}

const empresas = (await (await createPanelStore()).list('empresas')) as Empresa[];
if (!empresas.length) {
  console.error('No hay empresas cargadas. Primero: npm run empresas:importar -- --f29=... --previred=... --contactos=...');
  process.exit(1);
}

const feriados = new Set((flag('feriados') ?? '').split(',').filter(Boolean));
const plan = armarPlan(empresas, { mes, hoy, feriados, modo: args.includes('--corridos') ? 'corridos' : 'habiles' });
console.log(planATexto(plan));

const csv = flag('csv');
if (csv) {
  await writeFile(csv, planACsv(plan), 'utf8');
  console.log(`\nCSV guardado en ${csv}`);
}
process.exit(0);
