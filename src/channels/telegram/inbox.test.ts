import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedExtension, safeFileName } from './inbox.js';

describe('inbox', () => {
  it('safeFileName no deja escapar de la carpeta', () => {
    assert.equal(safeFileName('../../etc/passwd'), 'passwd');
    assert.equal(safeFileName('..\\..\\win.ini'), 'win.ini');
    assert.equal(safeFileName('...'), 'archivo');
  });

  it('safeFileName reemplaza caracteres raros y acota el largo', () => {
    assert.equal(safeFileName('Comprobantes sept 2026 (1).xlsx'), 'Comprobantes_sept_2026_1_.xlsx');
    assert.ok(safeFileName('a'.repeat(500) + '.xlsx').length <= 80);
  });

  it('solo acepta tipos de documento', () => {
    assert.equal(isAllowedExtension('a.XLSX'), true);
    assert.equal(isAllowedExtension('a.pdf'), true);
    assert.equal(isAllowedExtension('a.exe'), false);
    assert.equal(isAllowedExtension('a.zip'), false);
    assert.equal(isAllowedExtension('sin_extension'), false);
  });
});
