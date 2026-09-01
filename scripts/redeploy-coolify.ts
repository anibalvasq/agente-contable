/**
 * Redespliega la app en Coolify. Es el comando de todos los días:
 *
 *   git push && npm run redeploy
 *
 * ─────────────────────────────────────────────────────────────
 *  POR QUÉ ESTO Y NO UN WEBHOOK DE GITHUB
 * ─────────────────────────────────────────────────────────────
 * La forma "canónica" de auto-desplegar es conectar GitHub con Coolify por
 * webhook: entrás a Settings → Webhooks del repo, pegas la URL que te da
 * Coolify, copias el secreto, eliges los eventos. Funciona, pero son seis
 * pantallas entre dos plataformas y, cuando algo falla, el error aparece en un
 * log de entregas de GitHub que nadie mira.
 *
 * Coolify tiene un endpoint de deploy en su API. Si ya tienes la URL y el token
 * en tu .env — que los necesitas igual para `npm run deploy` — disparar un
 * despliegue es una llamada HTTP. Sin configurar nada en GitHub.
 *
 * Diferencia con `npm run deploy`:
 *   deploy    provisiona: claves, proyecto, app, variables de entorno. Se corre
 *             UNA vez (o cuando cambian las variables). Es idempotente.
 *   redeploy  solo dispara. No toca la configuración ni las variables.
 *
 * Si cambiaste algo del .env, ejecuta `npm run deploy`: este comando NO sube
 * variables nuevas, y el contenedor arrancaría con las viejas.
 *
 * Requiere en el .env: COOLIFY_URL, COOLIFY_API_TOKEN.
 * El nombre de la app se toma de APP_NAME (default: wa-agent).
 */
import { existsSync, readFileSync } from 'node:fs';

function readEnv(): Record<string, string> {
  if (!existsSync('.env')) {
    console.error('No hay archivo .env en este directorio.');
    console.error('  Copia .env.example a .env y completa COOLIFY_URL y COOLIFY_API_TOKEN.');
    process.exit(1);
  }

  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const env = readEnv();
for (const k of ['COOLIFY_URL', 'COOLIFY_API_TOKEN']) {
  if (!env[k]) {
    console.error(`Falta ${k} en el .env`);
    process.exit(1);
  }
}

const APP_NAME = env.APP_NAME || 'wa-agent';
const COOLIFY = env.COOLIFY_URL!.replace(/\/+$/, '');

async function coolify<T>(route: string): Promise<T> {
  const r = await fetch(`${COOLIFY}/api/v1${route}`, {
    headers: { Authorization: `Bearer ${env.COOLIFY_API_TOKEN}`, Accept: 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Coolify ${route} → ${r.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function main(): Promise<void> {
  // El uuid de la app se busca por nombre en vez de pidertelo: así el comando
  // funciona recién clonado, sin tener que ir a copiar un uuid del panel.
  const apps = await coolify<Array<{ uuid: string; name: string }>>('/applications');
  const app = apps.find((a) => a.name === APP_NAME);

  if (!app) {
    console.error(`No encontré la aplicación "${APP_NAME}" en Coolify.`);
    console.error(
      apps.length
        ? `  Las que hay: ${apps.map((a) => a.name).join(', ')}\n  Si la tuya se llama distinto, pon APP_NAME en el .env.`
        : '  No hay ninguna aplicación todavía. Ejecuta primero: npm run deploy',
    );
    process.exit(1);
  }

  const res = await coolify<{ deployments?: Array<{ deployment_uuid?: string }> }>(`/deploy?uuid=${app.uuid}`);
  const deploymentUuid = res.deployments?.[0]?.deployment_uuid;

  console.log(`✓ Deploy disparado para "${APP_NAME}" (${app.uuid})`);
  console.log(`  Síguelo en: ${COOLIFY}/project`);
  if (deploymentUuid) console.log(`  Deployment: ${deploymentUuid}`);
  console.log('\n  Cuando termine, verifica que quedó sano:');
  console.log('    curl https://TU-DOMINIO/health/ready');
}

main().catch((err) => {
  console.error('\n✗ No se pudo disparar el deploy.');
  console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  console.error('\n  Revisa que COOLIFY_URL apunte a tu panel (sin barra final) y que');
  console.error('  el COOLIFY_API_TOKEN tenga permiso sobre ese proyecto.');
  process.exit(1);
});
