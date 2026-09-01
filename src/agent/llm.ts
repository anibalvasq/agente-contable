import OpenAI from 'openai';
import { env } from '../env.js';

/**
 * Cliente del LLM vía OpenRouter (API compatible con OpenAI). Cambias de modelo
 * con LLM_MODEL — cualquiera de OpenRouter que soporte tool calling sirve
 * (anthropic/claude-*, openai/gpt-*, google/gemini-*, etc.).
 */
export const llm = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  defaultHeaders: {
    // OpenRouter los usa para atribuir el consumo en su dashboard.
    ...(env.APP_URL ? { 'HTTP-Referer': env.APP_URL } : {}),
    'X-Title': env.APP_TITLE,
  },
  maxRetries: 3,
  timeout: 60_000,
});
