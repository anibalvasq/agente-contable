import { z } from 'zod';

/**
 * Variables del canal WhatsApp Cloud API (Meta). Se validan solo si este canal
 * está activo (el registry lo importa recién ahí).
 *
 * De dónde salen: Meta for Developers → tu app → WhatsApp → API Setup.
 */
const schema = z.object({
  META_ACCESS_TOKEN: z.string().min(1, 'Falta META_ACCESS_TOKEN'),
  META_PHONE_NUMBER_ID: z.string().min(1, 'Falta META_PHONE_NUMBER_ID'),
  // El "Verify token" que inventas y pones igual en el dashboard de Meta.
  META_VERIFY_TOKEN: z.string().min(1, 'Falta META_VERIFY_TOKEN'),

  /**
   * App Secret: con esto se valida la firma HMAC de cada webhook.
   *
   * Antes era opcional, y eso era un agujero serio. Sin firma, la URL del
   * webhook es adivinable y cualquiera puede postear un payload de WhatsApp
   * inventado. Como el destinatario de la respuesta sale de ese mismo payload
   * (`messages[].from`), un tercero podía hacer que TU número le mandara
   * mensajes a CUALQUIER número: spam con tu identidad, y el baneo de tu cuenta
   * de WhatsApp Business después.
   *
   * Lo encontrás en: Meta for Developers → tu app → Settings → Basic → App Secret.
   *
   * Se puede omitir solo si pones WEBHOOK_REQUIRE_SIGNATURE=false, que es para
   * probar en local y nunca para producción.
   */
  META_APP_SECRET: z.string().optional(),

  META_GRAPH_VERSION: z.string().default('v20.0'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const detalle = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  console.error(`Config de Cloud API inválida:\n${detalle}`);
  process.exit(1);
}

// El chequeo cruzado va aquí y no en el schema para poder explicarlo bien: es el
// error que más gente va a ver al actualizar, y merece un mensaje que enseñe.
const requireSignature = (process.env.WEBHOOK_REQUIRE_SIGNATURE ?? 'true').toLowerCase() !== 'false';
if (requireSignature && !parsed.data.META_APP_SECRET) {
  console.error(
    [
      'Config de Cloud API inválida:',
      '  - META_APP_SECRET: falta, y sin él el webhook queda abierto.',
      '',
      '  Cualquiera que conozca tu URL podría hacer que tu número de WhatsApp',
      '  le mande mensajes a quien quiera. Copialo de:',
      '    Meta for Developers → tu app → Settings → Basic → App Secret',
      '',
      '  Para probar en local sin firma (NUNCA en producción):',
      '    WEBHOOK_REQUIRE_SIGNATURE=false',
    ].join('\n'),
  );
  process.exit(1);
}

export const cloudEnv = parsed.data;
