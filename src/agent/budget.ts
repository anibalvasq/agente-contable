import { logger } from '../logger.js';
import { notifyError } from '../notifications/index.js';

/**
 * Presupuesto de tokens: el freno de mano de la billetera.
 *
 * Sin esto, el peor caso no es "el bot responde mal", es "el bot responde
 * 40.000 veces". Basta un loop entre dos bots (el tuyo y el autoresponder de un
 * cliente), un atacante con la URL del webhook, o un bug tuyo reencolando, para
 * despertarte con una factura de tres cifras.
 *
 * Dos topes, porque protegen de cosas distintas:
 *
 *  - POR CONVERSACIÓN: contiene el daño de un usuario abusivo o de un loop con
 *    un contacto puntual. El resto de los clientes sigue atendido.
 *  - POR DÍA (global): es el techo real de gasto. Si se cruza, algo se rompió a
 *    nivel sistema y querés enterarte antes que en el resumen de facturación.
 *
 * Para dimensionar los topes según el volumen del negocio, ver budgetSizing.ts
 * (vive aparte porque lo usa `npm run setup`, que corre sin .env).
 *
 * El control es aproximado a propósito: se consulta ANTES del turno con lo
 * gastado hasta el turno anterior, así que el último turno puede pasarse un
 * poco del tope. El objetivo es cortar la hemorragia, no cobrar por milisegundo.
 */

export interface BudgetLimits {
  /** Tope de tokens por conversación en su ventana. 0 = sin tope. */
  perConversation: number;
  /** Ventana del tope por conversación, en ms. */
  conversationWindowMs: number;
  /** Tope global de tokens por día. 0 = sin tope. */
  perDay: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason?: 'conversacion' | 'global';
  /** Cuánto se lleva gastado en el tope que se agotó. */
  spent?: number;
}

const DAY_MS = 86_400_000;

// ─────────────────────────────────────────────────────────────
//  El contador
// ─────────────────────────────────────────────────────────────

/**
 * Contador acumulativo con ventana. Es lo mismo que un rate limit, pero en vez
 * de contar mensajes de a uno acumula cantidades arbitrarias (tokens).
 */
interface Counter {
  add(key: string, amount: number, windowMs: number): Promise<number>;
  get(key: string): Promise<number>;
}

/** Backend en RAM: para el demo, el canal web y despliegues de una instancia. */
class MemoryCounter implements Counter {
  private windows = new Map<string, { total: number; resetAt: number }>();

  async add(key: string, amount: number, windowMs: number): Promise<number> {
    const now = Date.now();
    const current = this.windows.get(key);
    if (!current || current.resetAt <= now) {
      this.windows.set(key, { total: amount, resetAt: now + windowMs });
      return amount;
    }
    current.total += amount;
    return current.total;
  }

  async get(key: string): Promise<number> {
    const current = this.windows.get(key);
    if (!current || current.resetAt <= Date.now()) return 0;
    return current.total;
  }
}

/** Backend en Redis: varias instancias comparten el mismo presupuesto. */
class RedisCounter implements Counter {
  constructor(
    private readonly client: {
      incrby(k: string, n: number): Promise<number>;
      pexpire(k: string, ms: number): Promise<number>;
      get(k: string): Promise<string | null>;
    },
  ) {}

  async add(key: string, amount: number, windowMs: number): Promise<number> {
    const total = await this.client.incrby(this.k(key), amount);
    // Solo el primer aporte pone el TTL; si no, la ventana nunca vencería.
    if (total === amount) await this.client.pexpire(this.k(key), windowMs);
    return total;
  }

  async get(key: string): Promise<number> {
    const raw = await this.client.get(this.k(key));
    return raw ? Number(raw) : 0;
  }

  private k(key: string): string {
    return `wak:budget:${key}`;
  }
}

let counter: Counter | null = null;

async function getCounter(useRedis: boolean): Promise<Counter> {
  if (counter) return counter;
  if (useRedis) {
    try {
      const { redis } = await import('../redis/client.js');
      counter = new RedisCounter(redis);
      return counter;
    } catch (err) {
      logger.warn({ err }, 'no se pudo usar Redis para el presupuesto; se cuenta en RAM');
    }
  }
  counter = new MemoryCounter();
  return counter;
}

/** Solo para los tests. */
export function resetBudgetCounter(): void {
  counter = null;
}

// ─────────────────────────────────────────────────────────────
//  La API que usa el runner
// ─────────────────────────────────────────────────────────────

/** ¿Queda presupuesto? Se llama antes de la primera llamada al modelo del turno. */
export async function checkBudget(
  conversationId: string,
  limits: BudgetLimits,
  useRedis: boolean,
): Promise<BudgetCheck> {
  const c = await getCounter(useRedis);

  if (limits.perConversation > 0) {
    const spent = await c.get(convKey(conversationId));
    if (spent >= limits.perConversation) {
      logger.warn({ conversationId, spent, limit: limits.perConversation }, 'presupuesto de conversación agotado');
      return { allowed: false, reason: 'conversacion', spent };
    }
  }

  if (limits.perDay > 0) {
    const spent = await c.get(globalKey());
    if (spent >= limits.perDay) {
      logger.error({ spent, limit: limits.perDay }, 'PRESUPUESTO DIARIO AGOTADO: el agente dejó de responder');

      // A partir de acá TODOS tus clientes reciben budget_reply. El bot no
      // falla: se apaga solo. Sin este mail te enterás cuando alguien reclama.
      void notifyError({
        key: 'presupuesto-diario',
        title: 'PRESUPUESTO DIARIO AGOTADO — el agente dejó de responder',
        detail:
          'Se cruzó max_tokens_per_day. Todos los clientes están recibiendo el mensaje de ' +
          'budget_reply en lugar del agente, hasta que cambie el día.\n\n' +
          'Si tu volumen creció, subí el tope: conversaciones_por_día × 40000 × 3.\n' +
          'Si NO creció, algo está en loop — revisá los logs por una conversación que no para.',
        context: { gastado: spent, tope: limits.perDay },
      });

      return { allowed: false, reason: 'global', spent };
    }
  }

  return { allowed: true };
}

/** Registra lo que consumió un turno. Se llama después de cada llamada al modelo. */
export async function recordUsage(
  conversationId: string,
  tokens: number,
  limits: BudgetLimits,
  useRedis: boolean,
): Promise<void> {
  if (tokens <= 0) return;
  const c = await getCounter(useRedis);

  if (limits.perConversation > 0) {
    await c.add(convKey(conversationId), tokens, limits.conversationWindowMs);
  }
  if (limits.perDay > 0) {
    await c.add(globalKey(), tokens, DAY_MS);
  }
}

const convKey = (conversationId: string) => `conv:${conversationId}`;
const globalKey = () => `global:${new Date().toISOString().slice(0, 10)}`;
