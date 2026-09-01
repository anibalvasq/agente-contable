import { env } from '../env.js';
import { logger } from '../logger.js';
import { requestJson } from '../integrations/http.js';

/**
 * Avisos por mail al desarrollador, vía Resend.
 *
 * Se usa `requestJson` en lugar del SDK de Resend a propósito: es un POST con
 * un header, y así el aviso hereda gratis los timeouts, los reintentos y el
 * backoff que el kit ya tiene — sin sumar una dependencia más.
 *
 * ─────────────────────────────────────────────────────────────
 *  POR QUÉ HAY UN FRENO (y por qué importa más que el envío)
 * ─────────────────────────────────────────────────────────────
 * La primera versión de esto siempre es "mandá un mail cuando algo falle". Y
 * después OpenRouter se cae diez minutos, fallan 300 turnos, y te llegan 300
 * mails idénticos. Tu casilla se vuelve inútil justo el día que la necesitabas,
 * y encima quemás la cuota de Resend.
 *
 * Por eso cada aviso tiene una CLAVE, y la misma clave no se repite dentro de
 * la ventana. El primer error te llega al instante; los siguientes iguales se
 * cuentan y se resumen en el próximo. Lo que te interesa es enterarte de que
 * algo pasa, no recibirlo 300 veces.
 */

/** Ventana del freno: un aviso por clave cada 15 minutos. */
const THROTTLE_MS = 15 * 60_000;

interface ThrottleEntry {
  /** Cuándo se mandó el último aviso de esta clave. */
  lastSentAt: number;
  /** Cuántos se suprimieron desde entonces. */
  suppressed: number;
}

const throttle = new Map<string, ThrottleEntry>();

export interface EmailNotice {
  /** Agrupa avisos equivalentes. Misma clave = mismo problema. */
  key: string;
  subject: string;
  /** Cuerpo en texto plano. Se manda tal cual. */
  body: string;
}

/**
 * Manda el aviso, si corresponde. Nunca lanza: un fallo del mail no puede
 * tumbar el turno que lo originó — sería cambiar un problema por otro peor.
 */
export async function sendAlert(notice: EmailNotice): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL_TO) {
    // Sin configurar, el aviso igual queda en los logs. No es un error.
    logger.info({ key: notice.key, subject: notice.subject }, 'aviso (sin RESEND_API_KEY: no se envía mail)');
    return;
  }

  const suppressed = shouldSendAlert(notice.key);
  if (suppressed === null) return; // frenado por la ventana

  const cola =
    suppressed > 0
      ? `\n\n(Se omitieron ${suppressed} avisos iguales en los últimos ${THROTTLE_MS / 60_000} minutos.)`
      : '';

  try {
    await requestJson('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
      body: {
        from: env.ALERT_EMAIL_FROM,
        to: [env.ALERT_EMAIL_TO],
        subject: notice.subject,
        text: notice.body + cola,
      },
      context: 'resend.send',
      // Un aviso no vale una espera larga: si Resend está lento, seguimos.
      timeoutMs: 8_000,
      retries: 1,
    });
    logger.info({ key: notice.key }, 'aviso enviado por mail');
  } catch (err) {
    // Solo se loguea. Que no llegue el mail es malo; que se caiga el agente
    // porque no llegó el mail es peor.
    logger.error({ err, key: notice.key }, 'no se pudo enviar el aviso por mail');
  }
}

/**
 * ¿Toca mandar? Devuelve cuántos avisos se venían suprimiendo (0 o más), o
 * null si este hay que frenarlo.
 *
 * Es la única parte con lógica de verdad de este módulo, así que se exporta
 * para poder testearla sin red. `now` es inyectable para poder probar el
 * vencimiento de la ventana sin esperar quince minutos.
 */
export function shouldSendAlert(key: string, now = Date.now()): number | null {
  const entry = throttle.get(key);

  if (!entry || now - entry.lastSentAt >= THROTTLE_MS) {
    const suppressed = entry?.suppressed ?? 0;
    throttle.set(key, { lastSentAt: now, suppressed: 0 });
    return suppressed;
  }

  entry.suppressed += 1;
  return null;
}

/** Solo para los tests. */
export function resetAlertThrottle(): void {
  throttle.clear();
}

export const ALERT_THROTTLE_MS = THROTTLE_MS;
