/**
 * Crea el .env a partir de .env.example si todavía no existe.
 *
 * Corre solo después de `npm install` (postinstall), así que cuando clonas el
 * repo e instalas, el archivo ya está esperándote con todas las variables
 * comentadas y explicadas. No hay que acordarse de ningún `cp`.
 *
 * ─────────────────────────────────────────────────────────────
 *  POR QUÉ NO VIENE EL .env EN EL REPO
 * ─────────────────────────────────────────────────────────────
 * Sería más simple commitearlo, y es exactamente así como se filtran las
 * credenciales: alguien clona, pone su API key de OpenRouter en ese archivo
 * versionado, hace `git add .` sin mirar, y su key termina publicada en GitHub.
 * Los bots que rastrean claves en repos públicos tardan minutos en encontrarla.
 *
 * Por eso .env está en .gitignore y siempre lo va a estar. Este script te da la
 * comodidad de tenerlo creado, sin el riesgo de que se suba.
 *
 * Nunca pisa un .env existente: si ya tienes credenciales cargadas, no las toca.
 */
import { copyFileSync, existsSync } from 'node:fs';

const DESTINO = '.env';
const ORIGEN = '.env.example';

if (existsSync(DESTINO)) {
  // Silencio a propósito: esto corre en cada npm install y no aporta nada.
  process.exit(0);
}

if (!existsSync(ORIGEN)) {
  // En un npm install desde otro directorio, o en una instalación como
  // dependencia, no hay ejemplo que copiar. No es un error.
  process.exit(0);
}

copyFileSync(ORIGEN, DESTINO);

console.log('');
console.log('  Se creó tu archivo .env a partir de .env.example.');
console.log('');
console.log('  Lo mínimo para arrancar el demo:');
console.log('    OPENROUTER_API_KEY   →  https://openrouter.ai/keys');
console.log('');
console.log('  Para conectar WhatsApp de verdad necesitas primero una URL pública:');
console.log('    COOLIFY_URL + COOLIFY_API_TOKEN  →  luego  npm run deploy');
console.log('');
