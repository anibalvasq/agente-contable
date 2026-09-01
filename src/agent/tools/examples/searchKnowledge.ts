import { loadConfig } from '../../../config.js';
import { text } from '../../args.js';
import type { Tool } from '../index.js';

/**
 * Ejemplo de herramienta que lee datos: busca en la base de conocimiento del
 * agent.yaml por palabras clave. Es un RAG-lite; para algo serio, reemplazá
 * esta búsqueda por embeddings + una base vectorial (pgvector, etc.).
 *
 * OJO con `returnsUntrustedContent` si la extendés. Hoy está en false porque el
 * contenido sale de TU agent.yaml: lo escribiste vos. En el momento en que esta
 * herramienta lea una web, un CRM, un Sheet compartido o un PDF del cliente,
 * pasá la bandera a true — si no, estarías metiendo texto de terceros en el
 * prompt sin marcar, que es el vector de inyección indirecta.
 */
export const searchKnowledge: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,

  definition: {
    type: 'function',
    function: {
      name: 'search_knowledge',
      description:
        'Busca información de la empresa (horarios, precios, políticas, FAQ) en la base de conocimiento. Usala ANTES de decir que no sabés algo.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Qué buscar, en pocas palabras.' } },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },

  async run(args) {
    const q = text(args.query);
    if (!q) return { results: [], found: 0 };

    const { knowledge } = loadConfig();
    const terms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const results = knowledge
      .map((entry) => ({ entry, score: terms.filter((t) => entry.toLowerCase().includes(t)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((x) => x.entry);

    // Devolvemos DATOS, no instrucciones.
    //
    // Antes esto traía un campo `note` que le decía al modelo "respondé con
    // esto, en tus palabras" / "decí que lo vas a consultar". Funcionaba, pero
    // enseñaba el hábito exacto que causa las inyecciones indirectas: mezclar
    // órdenes dentro de un payload de datos. Si el modelo aprende que las
    // herramientas le dan órdenes, va a obedecer también las que le meta un
    // atacante en el texto de una nota del CRM.
    //
    // Qué hacer con el resultado se define UNA vez, en el system prompt.
    return { results, found: results.length };
  },
};
