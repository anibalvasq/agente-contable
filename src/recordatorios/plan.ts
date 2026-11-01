import type { Empresa } from '../empresas/empresas.js';
import { fechasAviso, vencimientoDe, type ModoAviso, type Obligacion } from './calendario.js';

/**
 * Arma la lista de recordatorios de un mes: qué empresa recibe qué aviso, qué
 * día y en qué correos. NO envía nada: es la lista que una persona revisa. El
 * envío, cuando exista, saldrá de esta misma lista.
 */

export interface OpcionesPlan {
  /** Mes en que vencen las obligaciones, 'AAAA-MM'. */
  mes: string;
  /** 'YYYY-MM-DD'. Solo marca qué recordatorios ya pasaron. */
  hoy: string;
  feriados?: ReadonlySet<string>;
  modo?: ModoAviso;
  /** "Dos y un día antes". */
  diasAntes?: readonly number[];
}

export interface Recordatorio {
  empresaId: string;
  rut: string;
  empresa: string;
  encargado: string | null;
  tipo: Obligacion;
  vencimiento: string;
  enviarEl: string;
  diasAntes: number;
  /** Vacío = no se puede enviar (ver `alertas`). */
  para: string[];
  asunto: string;
  cuerpo: string;
  /** false si la fecha de envío ya pasó. */
  pendiente: boolean;
}

export interface Alerta {
  tipo: 'sin_correo' | 'rut_invalido' | 'sin_obligaciones' | 'sin_encargado';
  empresa: string;
  rut: string;
  detalle: string;
}

export interface Plan {
  mes: string;
  /** El texto de los correos es provisorio: los definitivos salen del proceso 3. */
  plantillaProvisoria: true;
  modo: ModoAviso;
  vencimientos: Record<Obligacion, string>;
  recordatorios: Recordatorio[];
  alertas: Alerta[];
}

const NOMBRE: Record<Obligacion, { titulo: string; que: string }> = {
  previred: { titulo: 'Previred', que: 'cotizaciones' },
  f29: { titulo: 'F29', que: 'impuestos' },
};

/** dd/mm/aaaa, como lo pide el correo tipo del Flujorama. */
export const fechaLarga = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** PROVISORIA: reemplazar por el correo tipo definitivo del proceso 3. */
export function plantillaRecordatorio(tipo: Obligacion, vencimiento: string): { asunto: string; cuerpo: string } {
  const { titulo, que } = NOMBRE[tipo];
  return {
    asunto: `Recordatorio de vencimiento ${titulo}`,
    cuerpo:
      `Estimados, buenos días, les recuerdo que con fecha ${fechaLarga(vencimiento)} vence el pago correspondiente de ${que}.\n\n` +
      'Les recuerdo efectuar el pago para no generar multas y morosidades.\n\n' +
      'Saluda atentamente.',
  };
}

export function armarPlan(empresas: readonly Empresa[], op: OpcionesPlan): Plan {
  const modo = op.modo ?? 'habiles';
  const diasAntes = op.diasAntes ?? [2, 1];
  const vencimientos: Record<Obligacion, string> = {
    previred: vencimientoDe('previred', op.mes, op.hoy, op.feriados),
    f29: vencimientoDe('f29', op.mes, op.hoy, op.feriados),
  };

  const recordatorios: Recordatorio[] = [];
  const alertas: Alerta[] = [];

  for (const e of empresas) {
    const base = { empresa: e.nombre || e.rut, rut: e.rut };
    if (!e.rutValido) alertas.push({ ...base, tipo: 'rut_invalido', detalle: 'El dígito verificador del RUT no calza.' });
    const tipos: Obligacion[] = [...(e.f29 ? (['f29'] as const) : []), ...(e.previred ? (['previred'] as const) : [])];
    if (!tipos.length) {
      alertas.push({ ...base, tipo: 'sin_obligaciones', detalle: 'No figura ni en F29 ni en Previred.' });
      continue;
    }
    if (!e.correos.length) alertas.push({ ...base, tipo: 'sin_correo', detalle: 'No tiene correo en el archivo de contactos: no recibirá recordatorios.' });
    if (!e.encargado) alertas.push({ ...base, tipo: 'sin_encargado', detalle: 'No tiene encargado en la base.' });

    for (const tipo of tipos) {
      const venc = vencimientos[tipo];
      const { asunto, cuerpo } = plantillaRecordatorio(tipo, venc);
      for (const a of fechasAviso(venc, diasAntes, modo, op.feriados)) {
        recordatorios.push({
          empresaId: e.id,
          rut: e.rut,
          empresa: e.nombre || e.rut,
          encargado: e.encargado,
          tipo,
          vencimiento: venc,
          enviarEl: a.fecha,
          diasAntes: a.diasAntes,
          para: e.correos,
          asunto,
          cuerpo,
          pendiente: a.fecha >= op.hoy,
        });
      }
    }
  }

  // Por fecha de envío y luego por empresa: es el orden en que se revisa.
  recordatorios.sort((a, b) => a.enviarEl.localeCompare(b.enviarEl) || a.tipo.localeCompare(b.tipo) || a.empresa.localeCompare(b.empresa));
  return { mes: op.mes, plantillaProvisoria: true, modo, vencimientos, recordatorios, alertas };
}

const celda = (v: string): string => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** CSV con ';' y BOM, para abrirlo directo en Excel en español. */
export function planACsv(plan: Plan): string {
  const filas = [
    ['Enviar el', 'Aviso', 'Obligación', 'Vence', 'Empresa', 'RUT', 'Encargado', 'Para', 'Estado'],
    ...plan.recordatorios.map((r) => [
      r.enviarEl,
      `${r.diasAntes} día${r.diasAntes === 1 ? '' : 's'} antes`,
      NOMBRE[r.tipo].titulo,
      r.vencimiento,
      r.empresa,
      r.rut,
      r.encargado ?? '',
      r.para.join(' '),
      !r.para.length ? 'SIN CORREO' : r.pendiente ? 'Pendiente' : 'Fecha pasada',
    ]),
  ];
  return '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n') + '\r\n';
}

export function planATexto(plan: Plan): string {
  const l: string[] = [
    `Recordatorios de ${plan.mes} (texto de los correos PROVISORIO; no se envía nada)`,
    `Previred vence el ${plan.vencimientos.previred} · F29 vence el ${plan.vencimientos.f29} · avisos en días ${plan.modo === 'habiles' ? 'hábiles' : 'corridos'}`,
    '',
  ];
  let dia = '';
  for (const r of plan.recordatorios) {
    if (r.enviarEl !== dia) {
      dia = r.enviarEl;
      l.push(`${dia}`);
    }
    l.push(`  ${NOMBRE[r.tipo].titulo.padEnd(8)} ${r.empresa} → ${r.para.length ? r.para.join(', ') : 'SIN CORREO'}`);
  }
  if (plan.alertas.length) {
    l.push('', `Alertas (${plan.alertas.length}):`);
    for (const a of plan.alertas) l.push(`  - ${a.empresa} (${a.rut}): ${a.detalle}`);
  }
  return l.join('\n');
}
