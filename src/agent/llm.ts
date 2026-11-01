import OpenAI from 'openai';
import { env } from '../env.js';

/**
 * Cliente del LLM sobre la API de OpenAI. Por defecto apunta a OpenRouter, pero
 * LLM_BASE_URL lo dirige a OpenAI o Anthropic directo. Cambias de modelo con
 * LLM_MODEL — cualquiera con tool calling sirve.
 */
export const llm = new OpenAI({
  // Sin key el cliente igual se crea (el panel arranca sin IA); la llamada al modelo falla con 401.
  apiKey: env.LLM_API_KEY_RESOLVED ?? 'sin-api-key-configurada',
  baseURL: env.LLM_BASE_URL_RESOLVED,
  // Solo OpenRouter los usa (atribuye el consumo en su dashboard); a OpenAI o
  // Anthropic no hace falta mandarles nada extra.
  defaultHeaders: env.LLM_BASE_URL_RESOLVED.includes('openrouter.ai')
    ? { ...(env.APP_URL ? { 'HTTP-Referer': env.APP_URL } : {}), 'X-Title': env.APP_TITLE }
    : {},
  maxRetries: 3,
  timeout: 60_000,
});
