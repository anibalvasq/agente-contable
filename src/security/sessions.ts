import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './signatures.js';

/**
 * Sesiones firmadas para el canal web.
 *
 * Antes el cliente mandaba el `sessionId` que quería y el server le creaba (o
 * le devolvía) esa conversación. Con eso, sabiendo el id de otra persona podías
 * retomar SU conversación y pedirle al agente que te resumiera lo hablado.
 *
 * La solución no es adivinar mejor: es que el id lo emita el SERVER y venga
 * firmado. Un id inventado por el cliente no valida y se le entrega uno nuevo.
 *
 * Formato:  <id-aleatorio-hex>.<hmac-truncado-hex>
 */

const ID_BYTES = 16;
const SIG_LENGTH = 32; // 128 bits de firma: de sobra para esto.

/** Emite un id de sesión nuevo, ya firmado. */
export function issueSessionId(secret: string): string {
  const id = randomBytes(ID_BYTES).toString('hex');
  return `${id}.${sign(id, secret)}`;
}

/**
 * Devuelve el id crudo si la firma es válida, o null si el valor fue inventado,
 * manipulado o firmado con otro secreto.
 */
export function verifySessionId(value: unknown, secret: string): string | null {
  if (typeof value !== 'string') return null;

  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;

  const id = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (!/^[0-9a-f]+$/.test(id) || signature.length !== SIG_LENGTH) return null;

  return safeEqual(signature, sign(id, secret)) ? id : null;
}

function sign(id: string, secret: string): string {
  return createHmac('sha256', secret).update(id).digest('hex').slice(0, SIG_LENGTH);
}
