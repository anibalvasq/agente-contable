/**
 * Despliega el agente en Coolify de punta a punta, idempotente.
 *
 *   npm run build && node dist-scripts/deploy-coolify.js   (o: tsx scripts/deploy-coolify.ts)
 *
 * Qué hace, y por qué en este orden:
 *   1. Genera un par de claves SSH (si no hay).
 *   2. Registra la privada en Coolify y la pública como deploy key (solo lectura)
 *      en GitHub — hace falta para clonar un repo privado.
 *   3. Crea el proyecto y la app apuntando a docker-compose.coolify.yml.
 *   4. Carga las variables de entorno ANTES de desplegar (si arranca sin ellas,
 *      el contenedor muere en la validación de env).
 *   5. Dispara el deploy.
 *
 * Requiere en el .env: COOLIFY_URL, COOLIFY_API_TOKEN, GITHUB_TOKEN, GITHUB_REPO.
 * Nombres del proyecto/app configurables con PROJECT_NAME / APP_NAME.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const DIR_KEYS = '.deploy-keys';
const COMPOSE = '/docker-compose.coolify.yml';
const BRANCH = 'main';

function readEnv(): Record<string, string> {
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
for (const k of ['COOLIFY_URL', 'COOLIFY_API_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO']) {
  if (!env[k]) {
    console.error(`Falta ${k} en el .env`);
    process.exit(1);
  }
}

const PROJECT_NAME = env.PROJECT_NAME || 'wa-agent-starter';
const APP_NAME = env.APP_NAME || 'wa-agent';
const COOLIFY = env.COOLIFY_URL!.replace(/\/+$/, '');
const REPO_SLUG = env.GITHUB_REPO!.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
const REPO_SSH = `git@github.com:${REPO_SLUG}.git`;

async function coolify<T>(method: string, route: string, body?: unknown): Promise<T> {
  const r = await fetch(`${COOLIFY}/api/v1${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.COOLIFY_API_TOKEN}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Coolify ${method} ${route} -> ${r.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function github<T>(method: string, route: string, body?: unknown): Promise<T> {
  const r = await fetch(`https://api.github.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`GitHub ${method} ${route} -> ${r.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

const step = (n: number, t: string) => console.log(`\n[${n}] ${t}`);

function generateKeys(): { privateKey: string; publicKey: string } {
  const priv = path.join(DIR_KEYS, 'coolify_deploy');
  const pub = `${priv}.pub`;
  if (existsSync(priv) && existsSync(pub)) {
    return { privateKey: readFileSync(priv, 'utf8'), publicKey: readFileSync(pub, 'utf8').trim() };
  }
  mkdirSync(DIR_KEYS, { recursive: true });
  execFileSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'coolify-deploy', '-f', priv], { stdio: 'pipe' });
  return { privateKey: readFileSync(priv, 'utf8'), publicKey: readFileSync(pub, 'utf8').trim() };
}

async function main() {
  step(1, 'Par de claves SSH para que Coolify clone el repo');
  const keys = generateKeys();

  step(2, 'Registrando la clave privada en Coolify');
  const existing = await coolify<Array<{ uuid: string; name: string }>>('GET', '/security/keys');
  let keyUuid = existing.find((k) => k.name === `${APP_NAME}-deploy`)?.uuid;
  if (!keyUuid) {
    const created = await coolify<{ uuid: string }>('POST', '/security/keys', {
      name: `${APP_NAME}-deploy`,
      description: 'Deploy key de solo lectura',
      private_key: keys.privateKey,
    });
    keyUuid = created.uuid;
  }
  console.log(`    ${keyUuid}`);

  step(3, 'Registrando la clave pública como deploy key en GitHub');
  const ghKeys = await github<Array<{ id: number; title: string }>>('GET', `/repos/${REPO_SLUG}/keys`);
  if (!ghKeys.find((k) => k.title === 'coolify-deploy')) {
    await github('POST', `/repos/${REPO_SLUG}/keys`, { title: 'coolify-deploy', key: keys.publicKey, read_only: true });
    console.log('    creada (solo lectura)');
  }

  step(4, 'Servidor destino');
  const servers = await coolify<Array<{ uuid: string; name: string; is_usable: boolean }>>('GET', '/servers');
  const server = servers.find((s) => s.is_usable) ?? servers[0];
  if (!server) throw new Error('Coolify no tiene servidor utilizable');
  console.log(`    ${server.name} (${server.uuid})`);

  step(5, 'Proyecto');
  const projects = await coolify<Array<{ uuid: string; name: string }>>('GET', '/projects');
  let project = projects.find((p) => p.name === PROJECT_NAME);
  if (!project) {
    project = await coolify<{ uuid: string; name: string }>('POST', '/projects', { name: PROJECT_NAME });
  }
  const detail = await coolify<{ environments: Array<{ uuid: string; name: string }> }>('GET', `/projects/${project.uuid}`);
  const environment = detail.environments?.[0];
  if (!environment) throw new Error('El proyecto no tiene entorno');
  console.log(`    ${project.uuid} / ${environment.name}`);

  step(6, 'Aplicación');
  const apps = await coolify<Array<{ uuid: string; name: string }>>('GET', '/applications');
  let app = apps.find((a) => a.name === APP_NAME);
  if (!app) {
    app = (await coolify('POST', '/applications/private-deploy-key', {
      project_uuid: project.uuid,
      server_uuid: server.uuid,
      environment_name: environment.name,
      environment_uuid: environment.uuid,
      private_key_uuid: keyUuid,
      git_repository: REPO_SSH,
      git_branch: BRANCH,
      build_pack: 'dockercompose',
      docker_compose_location: COMPOSE,
      name: APP_NAME,
      instant_deploy: false,
    })) as { uuid: string; name: string };
  }
  console.log(`    ${app.uuid}`);

  step(7, 'Variables de entorno');
  const SKIP = new Set([
    'COOLIFY_URL', 'COOLIFY_API_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'PROJECT_NAME', 'APP_NAME',
    'DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'PORT',
  ]);
  const vars = Object.entries(env)
    .filter(([k]) => !SKIP.has(k))
    .map(([key, value]) => ({ key, value, is_preview: false }));

  if ((env.STORE ?? 'postgres') === 'postgres' && !vars.some((v) => v.key === 'POSTGRES_PASSWORD')) {
    const pass = execFileSync('node', ['-e', "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"], { encoding: 'utf8' });
    vars.push({ key: 'POSTGRES_PASSWORD', value: pass, is_preview: false });
    console.log('    POSTGRES_PASSWORD generada');
  }

  await coolify('PATCH', `/applications/${app.uuid}/envs/bulk`, { data: vars });
  console.log(`    ${vars.length} variables cargadas`);

  step(8, 'Desplegando');
  await coolify('GET', `/deploy?uuid=${app.uuid}`);
  console.log(`\n✓ Deploy disparado. En Coolify: asigna un dominio a "${APP_NAME}" (puerto 3000) y mira los logs.`);
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
