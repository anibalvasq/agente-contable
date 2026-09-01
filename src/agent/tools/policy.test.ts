import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ConversationStore } from '../../memory/store.js';
import { checkToolPolicy, DEFAULT_TOOL_POLICY, newTurnUsage } from './policy.js';
import type { Tool, ToolContext } from './index.js';

function makeTool(name: string, sideEffect: 'read' | 'write'): Tool {
  return {
    sideEffect,
    definition: {
      type: 'function',
      function: { name, parameters: { type: 'object', properties: {} } },
    },
    async run() {
      return {};
    },
  };
}

function makeCtx(injectionFlags: string[] = []): ToolContext {
  return {
    contactId: 'c1',
    conversationId: 'conv1',
    contactName: null,
    store: {} as ConversationStore,
    injectionFlags,
  };
}

const leer = makeTool('buscar_precio', 'read');
const escribir = makeTool('crear_pedido', 'write');

describe('checkToolPolicy — lectura', () => {
  it('deja pasar siempre, incluso en un turno marcado', () => {
    const d = checkToolPolicy(leer, makeCtx(['ignorar-instrucciones']), newTurnUsage());
    assert.ok(d.allowed, 'si una herramienta de lectura se ejecuta de más, no rompe nada');
  });
});

describe('checkToolPolicy — escritura', () => {
  it('deja pasar en un turno limpio', () => {
    assert.ok(checkToolPolicy(escribir, makeCtx(), newTurnUsage()).allowed);
  });

  it('BLOQUEA en un turno donde se detectó manipulación', () => {
    // Esta es la regla más útil del archivo: el atacante necesita convencer al
    // modelo Y que la acción se ejecute. Esto corta lo segundo.
    const d = checkToolPolicy(escribir, makeCtx(['cambio-de-rol']), newTurnUsage());
    assert.equal(d.allowed, false);
    assert.ok(d.reason);
  });

  it('respeta el tope de escrituras por turno', () => {
    const usage = newTurnUsage();
    usage.writes = DEFAULT_TOOL_POLICY.maxWritesPerTurn;
    const d = checkToolPolicy(escribir, makeCtx(), usage);
    assert.equal(d.allowed, false, 'un modelo en loop no debería crear seis pedidos');
  });

  it('se puede aflojar con una policy propia', () => {
    const d = checkToolPolicy(escribir, makeCtx(['cambio-de-rol']), newTurnUsage(), {
      allowWriteWhenFlagged: true,
      maxWritesPerTurn: 10,
    });
    assert.ok(d.allowed);
  });
});
