import { env } from '../env.js';
import type { ChannelAdapter } from './types.js';

/**
 * Devuelve el adaptador de canal activo según CHANNEL_ADAPTER. Import dinámico
 * a propósito: solo se cargan las dependencias del canal que estás usando.
 *
 * Hoy el único canal es Telegram. Para agregar otro: implementa ChannelAdapter
 * (types.ts), súmalo al enum de CHANNEL_ADAPTER en env.ts y agrégalo aquí.
 */
export async function getActiveAdapter(): Promise<ChannelAdapter> {
  switch (env.CHANNEL_ADAPTER) {
    case 'telegram':
      return (await import('./telegram/adapter.js')).telegramAdapter;
    default:
      throw new Error(`CHANNEL_ADAPTER desconocido: ${env.CHANNEL_ADAPTER}`);
  }
}
