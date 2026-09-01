/**
 * Las claves de Redis y los scripts Lua del buffer.
 *
 * Vive en su propio módulo sin importar nada — igual que jobId.ts — porque
 * queues.ts abre conexiones a Redis al importarse, y un test de esta lógica no
 * debería levantar Redis. Acá los scripts se pueden probar contra un doble.
 *
 * ─────────────────────────────────────────────────────────────
 *  POR QUÉ LUA Y NO COMANDOS SUELTOS
 * ─────────────────────────────────────────────────────────────
 * Un turno toca cuatro claves (buffer, secuencia, pendiente, lock). Hacerlo con
 * comandos sueltos deja huecos entre uno y otro donde otro webhook del mismo
 * contacto se mete en el medio: dos jobs agendados, dos turnos, dos respuestas
 * al mismo usuario. Redis ejecuta cada script Lua de forma atómica, así que el
 * hueco desaparece.
 */

/** Cuánto viven las claves de una conversación inactiva, en segundos. */
export const TTL = 3_600;

/**
 * Vida del lock de conversación, en ms.
 *
 * Son 5 minutos y no 2 por una cuenta concreta: el cliente del LLM tiene
 * timeout de 60s y hasta 3 reintentos (ver agent/llm.ts), o sea hasta 4 minutos
 * en el peor caso, más lo que tarden las herramientas. Con un TTL más corto el
 * lock vencía a mitad del turno, otro worker tomaba la misma conversación y
 * salían las dos respuestas cruzadas que el lock existe para evitar.
 *
 * Igual el TTL es la red de seguridad, no el mecanismo: mientras el turno corre
 * el worker renueva el lock. El TTL solo decide cuánto queda trabada una
 * conversación si el proceso muere de golpe.
 */
export const LOCK_MS = 300_000;

/** Cada cuánto renovar: un tercio del TTL deja margen para dos fallos seguidos. */
export const LOCK_RENEW_MS = Math.floor(LOCK_MS / 3);

export const bufKey = (id: string) => `wak:buf:${id}`;
export const seqKey = (id: string) => `wak:seq:${id}`;
export const pendKey = (id: string) => `wak:pend:${id}`;
export const lockKey = (id: string) => `wak:lock:${id}`;
/** Los mensajes que un job concreto tomó para procesar. Ver CLAIM_LUA. */
export const procKey = (id: string, jobId: string) => `wak:proc:${id}:${jobId}`;

/**
 * Agrega el texto al buffer, avanza la secuencia y reserva el nuevo jobId, todo
 * en una sola operación atómica. Devuelve [jobId nuevo, jobId anterior].
 *
 * KEYS: buf, seq, pend · ARGV: texto, ttl, conversationId
 */
export const ENQUEUE_LUA = `
  local buf, seq, pend = KEYS[1], KEYS[2], KEYS[3]
  local text, ttl, convId = ARGV[1], ARGV[2], ARGV[3]

  redis.call('rpush', buf, text)
  redis.call('expire', buf, ttl)

  local n = redis.call('incr', seq)
  redis.call('expire', seq, ttl)

  -- Tiene que coincidir con buildJobId() de jobId.ts.
  --
  -- El string.format('%d') no es adorno: en Lua los números son floats, y según
  -- la versión que traiga tu Redis, concatenar el 1 puede dar "__1" o "__1.0". El
  -- segundo genera un jobId distinto del que espera el resto del código y rompe
  -- la cancelación del debounce. Formatear como entero lo vuelve determinista.
  local jobId = convId .. '__' .. string.format('%d', n)
  local previous = redis.call('get', pend)
  redis.call('set', pend, jobId, 'EX', ttl)

  return { jobId, previous or '' }
`;

/**
 * Mueve el buffer a una lista privada del job y devuelve todo lo acumulado.
 *
 * Antes esto era un "drenar y listo": se vaciaba el buffer ANTES de llamar al
 * modelo. Si el LLM o el envío fallaban, BullMQ reintentaba, el reintento
 * encontraba el buffer vacío y salía sin hacer nada. El mensaje del usuario se
 * perdía en silencio y nadie se enteraba.
 *
 * Ahora los mensajes no se borran: se MUEVEN a una lista que pertenece a ese
 * job, y se borra recién cuando el turno terminó bien (ACK). Un reintento del
 * mismo job vuelve a encontrar sus mensajes.
 *
 * La lista es POR JOB a propósito: si fuera compartida, un job nuevo se llevaría
 * los mensajes que otro está procesando y el usuario recibiría dos respuestas.
 *
 * KEYS: buf, proc · ARGV: ttl
 */
export const CLAIM_LUA = `
  local buf, proc = KEYS[1], KEYS[2]
  local ttl = ARGV[1]

  local nuevos = redis.call('lrange', buf, 0, -1)
  for i = 1, #nuevos do
    redis.call('rpush', proc, nuevos[i])
  end
  redis.call('del', buf)

  local todos = redis.call('lrange', proc, 0, -1)
  if #todos > 0 then redis.call('expire', proc, ttl) end
  return todos
`;

/**
 * Devuelve los mensajes al FRENTE del buffer. Se usa cuando un job agotó todos
 * sus reintentos: es preferible que el próximo mensaje del usuario arrastre los
 * anteriores a que se pierdan sin dejar rastro.
 *
 * KEYS: proc, buf · ARGV: ttl
 */
export const RETURN_LUA = `
  local proc, buf = KEYS[1], KEYS[2]
  local ttl = ARGV[1]

  local items = redis.call('lrange', proc, 0, -1)
  if #items == 0 then return 0 end

  -- de atrás para adelante, para que queden en el orden original
  for i = #items, 1, -1 do
    redis.call('lpush', buf, items[i])
  end
  redis.call('del', proc)
  redis.call('expire', buf, ttl)
  return #items
`;

/**
 * Extiende el lock, pero SOLO si sigue siendo nuestro. Sin el chequeo del
 * token, un worker zombi renovaría el lock que ya tomó otro.
 *
 * KEYS: lock · ARGV: token, ttl en ms
 */
export const RENEW_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('pexpire', KEYS[1], ARGV[2])
  else
    return 0
  end
`;

/** Libera el lock solo si es nuestro. KEYS: lock · ARGV: token */
export const RELEASE_LOCK_LUA = `
  if redis.call('get', KEYS[1]) == ARGV[1] then
    return redis.call('del', KEYS[1])
  else
    return 0
  end
`;
