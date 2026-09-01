/**
 * Asistente de configuración: te entrevista y arma tu agente sin tocar código.
 *
 *   npm run setup
 *
 * Te hace unas preguntas sobre tu negocio y escribe por ti:
 *   - config/agent.yaml  (personalidad + conocimiento del agente)
 *   - .env               (canal + credenciales)
 *
 * A diferencia de otros "generadores", NO inventa código: solo completa la
 * configuración. El agente ya está construido y probado; tú le das su identidad.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { stringify } from 'yaml';
import { suggestDailyBudget, TOKENS_POR_CONVERSACION } from '../src/agent/budgetSizing.js';

const TONES: Record<string, string> = {
  profesional: 'Profesional, claro y respetuoso.',
  amigable: 'Cercano y amigable, con calidez, sin ser informal de más.',
  vendedor: 'Persuasivo pero sin presionar: orientas la charla a que el cliente avance.',
  empatico: 'Empático: reconoces cómo se siente el cliente antes de responder.',
};

const CHANNELS = ['web', 'cloud-api', 'ghl', 'chatwoot', 'ycloud'];

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q: string, def = '') => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };

  console.log('\n  ✨ Configura tu agente de WhatsApp — responde y listo.\n');

  if (existsSync('config/agent.yaml') || existsSync('.env')) {
    const ok = (await ask('Ya hay config/.env. ¿Sobrescribir? (s/n)', 'n')).toLowerCase();
    if (ok !== 's' && ok !== 'si') {
      console.log('  Cancelado. No se tocó nada.\n');
      rl.close();
      return;
    }
  }

  const business = await ask('1/10 · Nombre de tu negocio', 'Mi Negocio');
  const whatDoes = await ask('2/10 · ¿A qué se dedica?', 'Vendemos productos y servicios');
  const purpose = await ask('3/10 · ¿Para qué quieres el agente? (responder dudas, agendar, tomar pedidos, calificar leads)', 'responder dudas');
  const agentName = await ask('4/10 · Nombre del agente (el que ven tus clientes)', 'Asistente');
  const toneKey = await ask(`5/10 · Tono (${Object.keys(TONES).join(' / ')})`, 'amigable');
  const hours = await ask('6/10 · Horario de atención', 'Lunes a Viernes de 9 a 18 hs');

  console.log('\n7/10 · Datos que el agente debe saber (horarios, precios, políticas, FAQ).');
  console.log('      Escribe uno por línea. Enter vacío para terminar.\n');
  const knowledge: string[] = [];
  for (;;) {
    const line = (await rl.question(`      · dato ${knowledge.length + 1}: `)).trim();
    if (!line) break;
    knowledge.push(line);
  }
  if (knowledge.length === 0) knowledge.push(`Horario de atención: ${hours}.`);

  let channel = (await ask(`8/10 · Canal (${CHANNELS.join(' / ')})`, 'web')).toLowerCase();
  if (!CHANNELS.includes(channel)) channel = 'web';

  // Pregunta de NEGOCIO, no técnica: el builder sabe cuántos clientes atiende.
  // Con eso el kit calcula el presupuesto de tokens, que sí es técnico.
  //
  // Importa que quede bien: el tope diario es un corte de emergencia. Si queda
  // por debajo del día normal, a media tarde TODOS los clientes empiezan a
  // recibir el mensaje de "estoy con muchas consultas" y el bot parece roto.
  const volumeRaw = await ask('9/10 · ¿Cuántas conversaciones por día esperás? (aproximado)', '150');
  const perDay = Math.max(10, Number.parseInt(volumeRaw, 10) || 150);

  const openrouterKey = await ask('10/10 · Tu API key de OpenRouter (https://openrouter.ai/keys)', '');

  // Credenciales del canal (solo las mínimas; el resto se completan a mano).
  const channelVars: Record<string, string> = {};
  if (channel === 'cloud-api') {
    channelVars.META_ACCESS_TOKEN = await ask('   · META_ACCESS_TOKEN (Enter para dejar en blanco)', '');
    channelVars.META_PHONE_NUMBER_ID = await ask('   · META_PHONE_NUMBER_ID', '');
    channelVars.META_VERIFY_TOKEN = await ask('   · META_VERIFY_TOKEN (inventa uno)', 'verify-' + business.toLowerCase().replace(/\s+/g, '-'));

    // Obligatorio: sin App Secret el webhook queda abierto y un tercero puede
    // hacer que tu número le mande WhatsApp a quien quiera. Ver
    // src/channels/cloud-api/env.ts.
    console.log('\n   El App Secret es OBLIGATORIO: sin él, cualquiera que conozca tu URL');
    console.log('   puede usar tu número para mandar mensajes. Lo copiás de:');
    console.log('   Meta for Developers → tu app → Settings → Basic → App Secret\n');
    channelVars.META_APP_SECRET = await ask('   · META_APP_SECRET', '');
  } else if (channel === 'ghl') {
    channelVars.GHL_API_TOKEN = await ask('   · GHL_API_TOKEN', '');
    channelVars.GHL_LOCATION_ID = await ask('   · GHL_LOCATION_ID', '');
    channelVars.WEBHOOK_SECRET = await ask('   · WEBHOOK_SECRET (Enter y te generamos uno)', randomSecret());
  } else if (channel === 'chatwoot' || channel === 'ycloud') {
    // Los stubs también piden secreto: encolan trabajo y hacen correr el LLM.
    console.log('\n   Este canal valida un secreto compartido en el header x-webhook-secret.');
    console.log('   Configúralo igual del lado de la plataforma.\n');
    channelVars.WEBHOOK_SECRET = await ask('   · WEBHOOK_SECRET (Enter y te generamos uno)', randomSecret());
  }

  rl.close();

  // ── config/agent.yaml ───────────────────────────────────────
  const tone = TONES[toneKey] ?? TONES.amigable;
  const systemPrompt = [
    `Eres ${agentName}, el asistente de WhatsApp de ${business} (${whatDoes}).`,
    '',
    'Cómo hablas:',
    `- ${tone}`,
    '- Mensajes cortos, es WhatsApp. Una sola pregunta por mensaje.',
    '- Nunca digas que eres un bot, una IA ni un asistente virtual.',
    '',
    'Tu objetivo:',
    `- ${purpose}.`,
    '- Usa la herramienta search_knowledge para responder con la info del negocio.',
    '',
    `Horario de atención: ${hours}.`,
    '',
    'Qué NUNCA haces:',
    '- Inventar datos. Si algo no sale de una herramienta ni del conocimiento, dilo',
    '  con honestidad y ofrece conectar con una persona del equipo.',
  ].join('\n');

  const agentYaml = stringify({
    name: agentName,
    system_prompt: systemPrompt,
    knowledge,
    greeting: `¡Hola! 👋 Soy ${agentName}, de ${business}. ¿En qué te ayudo?`,
  });
  writeFileSync('config/agent.yaml', agentYaml + guardrailsYaml(perDay, business));

  // ── .env ────────────────────────────────────────────────────
  const base = existsSync('.env.example') ? readFileSync('.env.example', 'utf8') : '';
  const overrides: Record<string, string> = {
    STORE: 'memory',
    CHANNEL_ADAPTER: channel,
    // Sin esto, cada reinicio le borra la conversación a todo el mundo.
    SESSION_SECRET: randomSecret(),
    ...(openrouterKey ? { OPENROUTER_API_KEY: openrouterKey } : {}),
    ...channelVars,
  };
  writeFileSync('.env', applyEnv(base, overrides));

  console.log(`\n  ✅ Listo. Escribe config/agent.yaml y .env.\n`);
  console.log(`     Agente:  ${agentName} · Canal: ${channel}\n`);
  console.log('  Pruébalo ahora:');
  console.log(channel === 'web' ? '     npm run demo        (abre http://localhost:3000)' : '     npm run chat        (chat de prueba en la terminal)');
  console.log('\n  Edita config/agent.yaml cuando quieras afinar la personalidad o el conocimiento.\n');
}

/**
 * Los límites de gasto y seguridad, ya calculados para el volumen declarado.
 *
 * Se arma como texto y no con stringify() a propósito: los comentarios son la
 * mitad del valor. El builder no tiene por qué entender de dónde sale el
 * número, pero sí tiene que poder cambiarlo cuando su negocio crezca.
 */
function guardrailsYaml(conversacionesPorDia: number, business: string): string {
  const perDay = suggestDailyBudget(conversacionesPorDia);

  return [
    '',
    '# ─────────────────────────────────────────────────────────────',
    `# Límites de gasto y seguridad, calculados para ~${conversacionesPorDia} conversaciones/día.`,
    '#',
    '# Todo esto tiene default: puedes borrar la sección entera y el agente sigue',
    '# funcionando. Está aquí para que lo veas y lo ajustes cuando crezcas.',
    '# ─────────────────────────────────────────────────────────────',
    'guardrails:',
    '  # Corte de emergencia diario. Si tu volumen sube, sube este número:',
    `  #   conversaciones_por_día × ${TOKENS_POR_CONVERSACION} × 3`,
    '  # Si queda corto, a media tarde TODOS tus clientes reciben budget_reply.',
    `  max_tokens_per_day: ${perDay}`,
    '',
    '  # Tope por conversación: contiene a un usuario abusivo o a un loop con',
    '  # otro bot, sin afectar al resto de tus clientes.',
    '  max_tokens_per_conversation: 200000',
    '',
    '  # ⚠️  ESTO LO COMPLETÁS VOS.',
    '  #',
    `  # ¿Qué cosas NO puede prometer tu agente en nombre de ${business}?`,
    '  # Si la respuesta del modelo matchea alguno de estos patrones, se manda',
    '  # blocked_reply en lugar de lo que dijo.',
    '  # Descomenta los que apliquen y agrega los tuyos:',
    '  forbidden_patterns: []',
    "  #  - '\\d{2,3}\\s*%\\s*(de\\s+)?descuento'",
    "  #  - 'te (lo )?(garantizo|aseguro|prometo)'",
    "  #  - 'devoluci[oó]n (total|del 100)'",
    '',
  ].join('\n');
}

/** Un secreto largo y aleatorio, para no depender de que el usuario invente uno. */
function randomSecret(): string {
  return randomBytes(32).toString('hex');
}

/** Reemplaza (o agrega) las variables dadas en el texto de un .env. */
function applyEnv(text: string, overrides: Record<string, string>): string {
  let out = text;
  for (const [key, value] of Object.entries(overrides)) {
    const re = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, `${key}=${value}`);
    else out += `\n${key}=${value}`;
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
