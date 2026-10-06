import { env } from '../env.js';
import type { ChannelAdapter } from './types.js';

/**
 * Devuelve el adaptador de canal activo según CHANNEL_ADAPTER. Import dinámico
 * a propósito: solo se cargan las dependencias del canal que estás usando (p.ej.
 * el canal web no arrastra el código de GHL ni de Meta).
 */
export async function getActiveAdapter(): Promise<ChannelAdapter> {
  switch (env.CHANNEL_ADAPTER) {
    case 'web':
      return (await import('./web/adapter.js')).webAdapter;
    case 'cloud-api':
      return (await import('./cloud-api/adapter.js')).cloudApiAdapter;
    case 'ghl':
      return (await import('./ghl/adapter.js')).ghlAdapter;
    case 'telegram':
      return (await import('./telegram/adapter.js')).telegramAdapter;
    case 'chatwoot':
      return (await import('./chatwoot/adapter.js')).chatwootAdapter;
    case 'ycloud':
      return (await import('./ycloud/adapter.js')).ycloudAdapter;
    default:
      throw new Error(`CHANNEL_ADAPTER desconocido: ${env.CHANNEL_ADAPTER}`);
  }
}
