/**
 * Chat por terminal contra el agente real, sin WhatsApp ni base de datos.
 *
 *   npm run chat
 *
 * Usa el store en memoria: perfecto para iterar el prompt y las herramientas.
 * Comandos: /reset (empezar de cero), /salir.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../src/config.js';
import { MemoryStore } from '../src/memory/memory.js';
import { runAgent } from '../src/agent/runner.js';

async function main() {
  const config = loadConfig();
  const store = new MemoryStore();
  const contact = await store.upsertContact({ externalId: 'cli-user', name: null });
  let conversation = await store.getOrCreateConversation(contact.id, 'cli-conv');

  const rl = createInterface({ input: stdin, output: stdout });

  console.log(`\n  ${config.name} — chat de prueba (store en memoria)`);
  console.log('  Comandos: /reset  /salir\n');
  if (config.greeting) console.log(`  ${config.name}: ${config.greeting}\n`);

  for (;;) {
    const userText = (await rl.question('  Tú: ')).trim();
    if (!userText) continue;
    if (userText === '/salir') break;
    if (userText === '/reset') {
      conversation = await store.getOrCreateConversation(contact.id, `cli-conv-${Date.now()}`);
      console.log('  (conversación reiniciada)\n');
      continue;
    }

    const { reply, toolsUsed } = await runAgent({ store, conversation, contact, userText, config });
    if (toolsUsed.length) console.log(`  · herramientas: ${toolsUsed.join(', ')}`);
    console.log(`  ${config.name}: ${reply ?? '(sin respuesta)'}\n`);
  }

  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
