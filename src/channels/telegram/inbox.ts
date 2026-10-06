import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Bandeja de documentos: lo que los clientes mandan por Telegram queda en disco
 * para que el equipo lo procese (p.ej. subir los Excel de comprobantes a
 * Defontana). El agente NO lee el contenido de los archivos: no hay herramienta
 * que los abra, así que un PDF con instrucciones escondidas no le llega al modelo.
 */

/** Tipos que aceptamos. Todo lo demás (ejecutables, zips…) se rechaza. */
const EXTENSIONS = new Set(['.xlsx', '.xls', '.csv', '.pdf', '.xml', '.jpg', '.jpeg', '.png']);

/** Tope de la Bot API para descargar archivos. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export const INBOX_DIR = path.resolve(process.cwd(), 'inbox');

/**
 * El nombre lo escribió el cliente: se reduce a caracteres seguros. Sin esto un
 * nombre como `../../x` escribiría fuera de la bandeja, y uno con instrucciones
 * viajaría tal cual al prompt.
 */
export function safeFileName(raw: string): string {
  const base = path.basename(raw.replace(/\\/g, '/'));
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(-80);
  return clean || 'archivo';
}

export function isAllowedExtension(fileName: string): boolean {
  return EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/** Guarda el archivo y devuelve el nombre con el que quedó. */
export async function saveToInbox(chatId: string, fileName: string, data: Buffer, now = new Date()): Promise<string> {
  // chatId viene de un entero de Telegram; aun así se sanea: es parte de una ruta.
  const dir = path.join(INBOX_DIR, `telegram-${chatId.replace(/[^0-9-]/g, '')}`);
  await mkdir(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15); // 20261005T143000
  const saved = `${stamp}-${safeFileName(fileName)}`;
  await writeFile(path.join(dir, saved), data);
  return saved;
}
