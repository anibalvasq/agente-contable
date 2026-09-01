/**
 * Guardas del AGENTE: las tres capas que rodean la llamada al modelo.
 *
 *   entrada  →  [input.ts]  normaliza y marca intentos de manipulación
 *      ↓
 *   prompt   →  [untrusted.ts]  separa tus instrucciones de los datos externos
 *      ↓
 *   modelo
 *      ↓
 *   salida   →  [output.ts]  revisa largo, fugas y patrones prohibidos
 *
 * Ninguna de las tres es infalible por separado, y ninguna reemplaza a la regla
 * de oro: que las acciones con consecuencias estén detrás de código que valida,
 * no detrás de un párrafo que le pide al modelo que se porte bien.
 */
export { guardUserInput, REINFORCEMENT } from './input.js';
export type { InjectionPolicy, InputGuardOptions, InputGuardResult } from './input.js';
export { guardReply } from './output.js';
export type { OutputGuardOptions, OutputGuardResult } from './output.js';
export { makeFenceId, untrustedContentRule, wrapUntrusted } from './untrusted.js';
