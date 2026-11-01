import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryCredentialStore, createVault } from './vault.js';
import { cifrar, descifrar, generarLlave, leerLlave } from '../security/vault.js';

describe('cifrado de claves', () => {
  const llave = leerLlave(generarLlave());

  it('cifra y descifra, y no deja la clave a la vista', () => {
    const token = cifrar('Cl4ve-secreta', llave, 'a');
    assert.ok(!token.includes('Cl4ve'));
    assert.equal(descifrar(token, llave, 'a'), 'Cl4ve-secreta');
  });

  it('cada cifrado es distinto aunque la clave sea la misma (IV nuevo)', () => {
    assert.notEqual(cifrar('x', llave, 'a'), cifrar('x', llave, 'a'));
  });

  it('no descifra con otra llave, ni con el dato alterado, ni fuera de su fila', () => {
    const token = cifrar('secreta', llave, 'fila-1');
    assert.throws(() => descifrar(token, leerLlave(generarLlave()), 'fila-1'));
    assert.throws(() => descifrar(token, llave, 'fila-2'));
    const partes = token.split('.');
    partes[3] = Buffer.from('otra-cosa').toString('base64url');
    assert.throws(() => descifrar(partes.join('.'), llave, 'fila-1'));
  });

  it('rechaza una llave ausente o de largo incorrecto', () => {
    assert.throws(() => leerLlave(undefined), /CREDENTIALS_KEY/);
    assert.throws(() => leerLlave(Buffer.from('corta').toString('base64')), /32 bytes/);
  });
});

describe('bóveda', () => {
  it('guarda cifrado en el almacén y devuelve la clave original', async () => {
    const store = createMemoryCredentialStore();
    const vault = createVault(store, generarLlave());
    await vault.guardar('76123456-7', 'sii', 'MiClaveSII');
    assert.ok(!(await store.get('76123456-7', 'sii'))!.includes('MiClaveSII'));
    assert.equal(await vault.obtener('76123456-7', 'sii'), 'MiClaveSII');
    assert.equal(await vault.obtener('76123456-7', 'previred'), undefined);
    assert.deepEqual(await vault.listar(), [{ rut: '76123456-7', sistema: 'sii' }]);
  });

  it('una clave copiada a otra empresa no se puede leer', async () => {
    const store = createMemoryCredentialStore();
    const vault = createVault(store, generarLlave());
    await vault.guardar('76123456-7', 'sii', 'secreta');
    await store.put('11111111-1', 'sii', (await store.get('76123456-7', 'sii'))!);
    await assert.rejects(vault.obtener('11111111-1', 'sii'));
  });

  it('no se puede crear sin llave', () => {
    assert.throws(() => createVault(createMemoryCredentialStore(), undefined), /CREDENTIALS_KEY/);
  });
});
