import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUpdate } from './parse.js';

const base = {
  update_id: 10,
  message: {
    message_id: 1,
    text: ' Hola ',
    from: { id: 42, first_name: 'Ana', last_name: 'Pérez', username: 'ana' },
    chat: { id: 42, type: 'private' },
  },
};

describe('telegram parseUpdate', () => {
  it('extrae texto, contacto y nombre de un chat privado', () => {
    const m = parseUpdate(base)!;
    assert.equal(m.externalContactId, '42');
    assert.equal(m.text, 'Hola');
    assert.equal(m.name, 'Ana Pérez');
    assert.equal(m.externalMessageId, '10');
    assert.equal(m.isInbound, true);
  });

  it('ignora grupos', () => {
    assert.equal(parseUpdate({ ...base, message: { ...base.message, chat: { id: -1, type: 'group' } } }), null);
  });

  it('ignora a otros bots', () => {
    assert.equal(parseUpdate({ ...base, message: { ...base.message, from: { id: 7, is_bot: true } } }), null);
  });

  it('ignora mensajes sin texto', () => {
    const { text: _t, ...sinTexto } = base.message;
    assert.equal(parseUpdate({ update_id: 11, message: sinTexto }), null);
  });

  it('ignora updates que no son mensajes', () => {
    assert.equal(parseUpdate({ update_id: 12 }), null);
  });

  it('un documento sin texto es un mensaje con adjunto', () => {
    const m = parseUpdate({
      update_id: 13,
      message: { ...base.message, text: undefined, document: { file_id: 'F1', file_name: 'comprobantes.xlsx', file_size: 900 } },
    })!;
    assert.equal(m.text, '');
    assert.deepEqual(m.attachment, { fileId: 'F1', fileName: 'comprobantes.xlsx', size: 900 });
  });

  it('de una foto toma el tamaño más grande y usa el caption como texto', () => {
    const m = parseUpdate({
      update_id: 14,
      message: {
        ...base.message,
        text: undefined,
        caption: 'boleta de septiembre',
        photo: [{ file_id: 'chica' }, { file_id: 'grande' }],
      },
    })!;
    assert.equal(m.text, 'boleta de septiembre');
    assert.equal(m.attachment?.fileId, 'grande');
  });
});
