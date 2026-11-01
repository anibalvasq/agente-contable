/**
 * Traduce un error de conexión/consulta a Postgres en una causa corta que se puede mostrar
 * públicamente: dice QUÉ arreglar sin revelar el host, el usuario ni la contraseña.
 * (El mensaje crudo del driver solo se muestra fuera de producción.)
 */
export function motivoErrorDb(err: unknown): { motivo: string; ayuda: string } {
  const e = err as { code?: string; message?: string } | undefined;
  const code = e?.code ?? '';
  const msg = (e?.message ?? '').toLowerCase();

  if (code === 'ERR_INVALID_URL' || msg.includes('invalid url') || msg.includes('invalid connection string'))
    return { motivo: 'url_invalida', ayuda: 'DATABASE_URL no es una cadena de Postgres válida. Debe empezar con postgresql:// (revisa caracteres especiales en la contraseña).' };
  if (code === '28P01' || msg.includes('password authentication failed'))
    return { motivo: 'password_rechazada', ayuda: 'La contraseña del rol en DATABASE_URL no coincide con la del rol agente_contable_app.' };
  if (msg.includes('tenant or user not found'))
    return { motivo: 'usuario_no_encontrado', ayuda: 'El usuario debe ser agente_contable_app.<ref-del-proyecto> (con el punto y el ref), y el host el del pooler del proyecto.' };
  if (code === '28000' || msg.includes('no pg_hba') || msg.includes('not allowed'))
    return { motivo: 'acceso_denegado', ayuda: 'El servidor rechazó la conexión (¿SSL o rol sin permiso de login?).' };
  if (code === 'ENOTFOUND') return { motivo: 'host_no_existe', ayuda: 'El host de DATABASE_URL no existe. Cópialo del botón Connect → Transaction pooler.' };
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || msg.includes('timeout') || msg.includes('connection terminated'))
    return { motivo: 'sin_conexion', ayuda: 'No se pudo llegar al servidor de la base. Usa el pooler (puerto 6543), no la dirección directa db.<ref>.supabase.co.' };
  if (msg.includes('self-signed') || msg.includes('ssl') || msg.includes('certificate'))
    return { motivo: 'ssl', ayuda: 'Problema de TLS. Define DATABASE_SSL=require.' };
  if (code === '3D000') return { motivo: 'base_no_existe', ayuda: 'El nombre de la base al final de DATABASE_URL debe ser postgres.' };
  if (code === '42P01') return { motivo: 'tabla_no_existe', ayuda: 'No se encontró la tabla equipo: el rol no ve el esquema agente_contable (search_path) o falta la migración 0004.' };
  if (code === '42501') return { motivo: 'sin_permiso', ayuda: 'El rol no tiene permiso sobre agente_contable.equipo. Reaplica supabase/agente_contable_seguridad.sql.' };
  return { motivo: 'desconocido', ayuda: 'Error no clasificado. Revisa los Runtime Logs del despliegue en Vercel.' };
}
