/**
 * Cómo dimensionar el presupuesto de tokens a partir del volumen del negocio.
 *
 * ─────────────────────────────────────────────────────────────
 *  POR QUÉ ESTE ARCHIVO NO IMPORTA NADA
 * ─────────────────────────────────────────────────────────────
 * Igual que jobId.ts, vive solo y a propósito. Lo usa `npm run setup`, que es
 * lo PRIMERO que corre alguien que acaba de clonar el repo — cuando todavía no
 * existe el .env. Si esto importara budget.ts, arrastraría logger.ts → env.ts,
 * que corta el proceso si falta OPENROUTER_API_KEY, y la entrevista moriría
 * antes de la primera pregunta.
 *
 * Regla general del kit: todo lo que consuma un script de arranque tiene que
 * poder importarse sin configuración.
 */

/**
 * Cuánto gasta, en tokens, una conversación de WhatsApp típica (~20 turnos).
 *
 * El número sorprende por lo alto porque el historial viaja ENTERO en cada
 * llamada: el costo no crece con la cantidad de mensajes sino con su cuadrado.
 * Es la intuición que casi nadie tiene cuando dimensiona esto por primera vez.
 */
export const TOKENS_POR_CONVERSACION = 40_000;

/**
 * Margen sobre el uso normal. El tope diario es un corte de EMERGENCIA, no un
 * acelerador: tiene que dejar pasar un día bueno y frenar un loop con otro bot.
 */
const MARGEN = 3;

/** Piso: ni con una respuesta absurda en la entrevista el bot queda mudo. */
const MINIMO_CONVERSACIONES = 10;

/**
 * Sugiere el tope diario a partir de algo que el dueño del negocio sí sabe:
 * cuántas conversaciones atiende por día.
 *
 * Existe para que nadie tenga que entender la aritmética de arriba para
 * configurar el kit.
 *
 * Quedarse CORTO aquí es peor que quedarse largo: cuando el tope se cruza, todos
 * los clientes empiezan a recibir `budget_reply` en lugar del agente. El bot no
 * falla — se apaga solo, en silencio, y nadie sabe por qué.
 */
export function suggestDailyBudget(conversationsPerDay: number): number {
  const seguras = Math.max(MINIMO_CONVERSACIONES, Math.floor(conversationsPerDay) || 0);
  return seguras * TOKENS_POR_CONVERSACION * MARGEN;
}
