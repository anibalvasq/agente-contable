import type { Tool } from '../index.js';

/**
 * Ejemplo de herramienta SIN estado ni dependencias: la más simple posible.
 * Devuelve la fecha y hora actual.
 */
export const getCurrentTime: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,

  definition: {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Devuelve la fecha y hora actual. Usala si el usuario pregunta el día u hora.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  async run() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      readable: now.toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
      timezone: 'America/Santiago',
    };
  },
};
