import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compara dos strings sin filtrar información por tiempo de respuesta. Con
 * `===`, un atacante puede descubrir un secreto carácter por carácter midiendo
 * cuánto tarda el rechazo.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual exige el mismo largo; el largo en sí no es un secreto.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Valida un secreto compartido recibido en un header. */
export function sharedSecretValid(received: unknown, expected: string | undefined): boolean {
  if (!expected) return false;
  if (typeof received !== 'string' || received.length === 0) return false;
  return safeEqual(received, expected);
}

/**
 * Verifica una firma HMAC-SHA256 (p.ej. `x-hub-signature-256: sha256=<hex>` de
 * Meta). `raw` es el cuerpo crudo del request, tal cual llegó.
 */
export function hmacSha256Valid(raw: Buffer | string, signatureHeader: unknown, secret: string): boolean {
  if (typeof signatureHeader !== 'string') return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  // Mismo largo garantizado (hex de sha256), pero safeEqual igual lo chequea.
  return safeEqual(signatureHeader, expected);
}
