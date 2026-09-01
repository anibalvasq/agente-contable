/**
 * Seguridad de la CAPA DE TRANSPORTE: quién puede hablarle al server y cuánto.
 *
 *  - signatures.ts  firmas HMAC y secretos compartidos de los webhooks.
 *  - rateLimit.ts   límite de mensajes por IP y por contacto.
 *  - sessions.ts    ids de sesión firmados (canal web).
 *
 * La seguridad de la capa del AGENTE (inyección de prompts, contenido no
 * confiable, validación de la respuesta) vive aparte, en src/agent/guards/.
 */
export { hmacSha256Valid, safeEqual, sharedSecretValid } from './signatures.js';
export { getRateLimiter, MemoryRateLimiter, RedisRateLimiter, resetRateLimiter } from './rateLimit.js';
export type { RateLimiter, RateLimitResult } from './rateLimit.js';
export { issueSessionId, verifySessionId } from './sessions.js';
