import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryMessage } from '../memory/store.js';
import { estimateTokens, fitHistory } from './tokens.js';

const user = (content: string): HistoryMessage => ({ role: 'user', content });
const assistant = (content: string | null, toolCalls?: unknown[]): HistoryMessage => ({
  role: 'assistant',
  content,
  toolCalls: toolCalls ?? null,
});
const tool = (content: string, id = 'call_1'): HistoryMessage => ({ role: 'tool', content, toolCallId: id });

describe('estimateTokens', () => {
  it('estima por caracteres', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.ok(estimateTokens('a'.repeat(400)) >= 100);
  });
});

describe('fitHistory', () => {
  it('devuelve el historial entero si entra', () => {
    const h = [user('hola'), assistant('¡hola!')];
    assert.deepEqual(fitHistory(h, 10_000), h);
  });

  it('recorta los mensajes más viejos y conserva los recientes', () => {
    const h = Array.from({ length: 100 }, (_, i) => user(`mensaje número ${i} `.repeat(20)));
    const out = fitHistory(h, 500);

    assert.ok(out.length < h.length, 'tiene que recortar');
    assert.equal(out.at(-1), h.at(-1), 'el último mensaje nunca se descarta');
  });

  it('recorta por TAMAÑO, no por cantidad', () => {
    // Diez mensajes cortos entran; dos con un resultado de herramienta gigante, no.
    const cortos = Array.from({ length: 10 }, () => user('ok'));
    const gordos = [user('hola'), tool(JSON.stringify({ data: 'x'.repeat(20_000) }))];

    assert.equal(fitHistory(cortos, 2_000).length, 10);
    assert.ok(fitHistory(gordos, 2_000).length < 2);
  });

  it('nunca deja un `tool` huérfano al principio', () => {
    // Si el corte separa el par assistant+tool, la API rechaza el request entero.
    const h = [
      user('a'.repeat(8_000)),
      assistant(null, [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{}' } }]),
      tool('resultado'),
      assistant('listo'),
    ];
    const out = fitHistory(h, 100);
    assert.notEqual(out[0]?.role, 'tool');
  });
});
