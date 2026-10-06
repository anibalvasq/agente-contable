import type OpenAI from 'openai';
import type { ConversationStore } from '../../memory/store.js';

/**
 * Una herramienta = una función que el LLM puede decidir llamar. Definís su
 * schema (lo que ve el modelo) y su `run` (lo que pasa cuando la llama).
 *
 * Para agregar la tuya: copia una de tools/examples/, registrala en el array
 * `defaultTools` de abajo, y listo. El runner se encarga del resto.
 *
 * Las DOS declaraciones que tienes que pensar bien son `sideEffect` y
 * `returnsUntrustedContent`. No son burocracia: de ellas dependen las defensas
 * del kit, y equivocarlas las apaga en silencio.
 */

/** Lo que recibe una herramienta además de sus argumentos. */
export interface ToolContext {
  contactId: string;
  conversationId: string;
  contactName: string | null;
  /** Por si tu herramienta necesita leer/escribir estado. */
  store: ConversationStore;
  /**
   * Patrones de manipulación detectados en el mensaje del usuario en este
   * turno. Vacío = mensaje limpio. La policy lo usa para frenar las
   * herramientas de escritura cuando el turno viene envenenado.
   */
  injectionFlags: string[];
}

/**
 * ¿Esta herramienta cambia algo del mundo real?
 *
 *  - 'read'  consulta y devuelve datos. Si se ejecuta de más, no pasa nada.
 *  - 'write' crea un pedido, cobra, agenda, manda un mail, aplica un descuento.
 *            Si se ejecuta de más, tienes un problema con un cliente real.
 *
 * Marca 'write' ante la duda. Las de escritura pasan por tools/policy.ts antes
 * de ejecutarse.
 */
export type ToolSideEffect = 'read' | 'write';

export interface Tool {
  definition: OpenAI.Chat.Completions.ChatCompletionTool;

  /** Ver ToolSideEffect. Ante la duda, 'write'. */
  sideEffect: ToolSideEffect;

  /**
   * ¿El resultado puede contener texto escrito por alguien de afuera?
   *
   * Marca true si tu herramienta lee: una web, una nota de CRM, un mail, un
   * PDF que mandó el cliente, una fila de un Sheet compartido, la respuesta de
   * una API de terceros. Todo eso lo escribió una persona que no eres tú, y
   * puede traer instrucciones dirigidas al modelo.
   *
   * Con true, el runner envuelve el resultado en una valla de datos externos
   * (ver guards/untrusted.ts) para que el modelo lo lea como información y no
   * como órdenes. Es el caso MÁS COMÚN y el que más se olvida.
   *
   * Déjalo en false solo si el contenido sale enteramente de ti: tu
   * agent.yaml, tu código, tu base de datos con datos que tú escribiste.
   */
  returnsUntrustedContent?: boolean;

  run(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

import { escalateToHuman } from './examples/escalateToHuman.js';
import { getCurrentTime } from './examples/getCurrentTime.js';
import { searchKnowledge } from './examples/searchKnowledge.js';
import { chileTools } from './chile/tools.js';

/** Las herramientas que el agente tiene disponibles. Suma las tuyas aquí. */
export const defaultTools: Tool[] = [getCurrentTime, searchKnowledge, ...chileTools, escalateToHuman];
