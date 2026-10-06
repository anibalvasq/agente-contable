import { list, positiveNumber, text } from '../../args.js';
import type { Tool } from '../index.js';
import {
  calcularHonorarios,
  calcularIva,
  calcularPpm,
  hoyChile,
  periodoAnterior,
  retencionHonorariosPct,
  vencimientosF29,
} from './calc.js';

/**
 * Herramientas de cálculo tributario de Chile. Las cuatro son 'read' y no traen
 * contenido de terceros: reciben números y devuelven números. No tocan la base
 * de datos ni mandan nada afuera, así que no hay nada que validar contra ella.
 */

export const calcularIvaTool: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,
  definition: {
    type: 'function',
    function: {
      name: 'calcular_iva',
      description:
        'Calcula neto, IVA (19%) y bruto de un monto en pesos chilenos. Úsala siempre que haya que ' +
        'sumar o separar el IVA; no hagas la cuenta tú.',
      parameters: {
        type: 'object',
        properties: {
          monto: { type: 'number', description: 'Monto en CLP.' },
          base: {
            type: 'string',
            enum: ['neto', 'bruto'],
            description: "'neto' si el monto NO incluye IVA; 'bruto' si ya lo incluye.",
          },
        },
        required: ['monto', 'base'],
        additionalProperties: false,
      },
    },
  },
  async run(args) {
    const monto = positiveNumber(args.monto);
    const base = list(args.base, ['neto', 'bruto'] as const)?.[0];
    if (!monto || !base) return { error: 'argumentos_invalidos' };
    return calcularIva(monto, base);
  },
};

export const calcularHonorariosTool: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,
  definition: {
    type: 'function',
    function: {
      name: 'calcular_honorarios',
      description:
        'Calcula la retención de una boleta de honorarios (bruto, retención y líquido). Sirve para ' +
        'saber cuánto retener, cuánto se recibe, o cuánto hay que emitir para recibir un líquido dado.',
      parameters: {
        type: 'object',
        properties: {
          monto: { type: 'number', description: 'Monto en CLP.' },
          base: {
            type: 'string',
            enum: ['bruto', 'liquido'],
            description: "'bruto' si es el monto de la boleta; 'liquido' si es lo que se quiere recibir.",
          },
          anio: {
            type: 'number',
            description: 'Año de emisión de la boleta. Si el usuario no lo dijo, no lo envíes.',
          },
        },
        required: ['monto', 'base'],
        additionalProperties: false,
      },
    },
  },
  async run(args) {
    const monto = positiveNumber(args.monto);
    const base = list(args.base, ['bruto', 'liquido'] as const)?.[0];
    if (!monto || !base) return { error: 'argumentos_invalidos' };

    const anio = positiveNumber(args.anio) ?? Number(hoyChile().slice(0, 4));
    const tasa = retencionHonorariosPct(Math.trunc(anio));
    if (tasa === undefined) return { error: 'anio_no_soportado', anio, soportados: '2025 en adelante' };

    return { anio: Math.trunc(anio), ...calcularHonorarios(monto, base, tasa) };
  },
};

export const calcularPpmTool: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,
  definition: {
    type: 'function',
    function: {
      name: 'calcular_ppm',
      description:
        'Calcula el PPM (pago provisional mensual) = ventas netas del mes × tasa. La tasa NO se asume: ' +
        'depende del régimen y de la última declaración (código 115 del F29); debe darla el usuario.',
      parameters: {
        type: 'object',
        properties: {
          ventas_netas: { type: 'number', description: 'Ventas netas del mes en CLP.' },
          tasa_pct: { type: 'number', description: 'Tasa de PPM en porcentaje, p.ej. 0.25.' },
        },
        required: ['ventas_netas', 'tasa_pct'],
        additionalProperties: false,
      },
    },
  },
  async run(args) {
    const ventas = positiveNumber(args.ventas_netas);
    const tasa = positiveNumber(args.tasa_pct);
    // Una tasa de PPM por encima de 10% es casi seguro un error de tipeo.
    if (!ventas || !tasa || tasa > 10) return { error: 'argumentos_invalidos' };
    return calcularPpm(ventas, tasa);
  },
};

export const consultarVencimientosTool: Tool = {
  sideEffect: 'read',
  returnsUntrustedContent: false,
  definition: {
    type: 'function',
    function: {
      name: 'consultar_vencimientos',
      description:
        'Devuelve las fechas de vencimiento del F29 (IVA y PPM) de un período tributario, con los días ' +
        'que faltan desde hoy. Si el usuario no indica el período, se usa el mes anterior.',
      parameters: {
        type: 'object',
        properties: {
          periodo: {
            type: 'string',
            description: "Período tributario 'AAAA-MM' (el mes que se declara, no el de vencimiento). Opcional.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  async run(args) {
    const hoy = hoyChile();
    const dado = text(args.periodo);
    if (dado !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(dado)) return { error: 'periodo_invalido' };
    const periodo = dado ?? periodoAnterior(hoy);

    return { hoy, periodo, considera_feriados: false, vencimientos: vencimientosF29(periodo, hoy) };
  },
};

export const chileTools: Tool[] = [
  calcularIvaTool,
  calcularHonorariosTool,
  calcularPpmTool,
  consultarVencimientosTool,
];
