import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { motivoErrorDb } from './diagnostico.js';

const e = (code: string | undefined, message = '') => Object.assign(new Error(message), code ? { code } : {});

describe('motivoErrorDb', () => {
  it('reconoce las causas típicas con Supabase', () => {
    assert.equal(motivoErrorDb(e('28P01', 'password authentication failed for user "x"')).motivo, 'password_rechazada');
    assert.equal(motivoErrorDb(e('XX000', 'Tenant or user not found')).motivo, 'usuario_no_encontrado');
    assert.equal(motivoErrorDb(e('ENOTFOUND')).motivo, 'host_no_existe');
    assert.equal(motivoErrorDb(e('ETIMEDOUT')).motivo, 'sin_conexion');
    assert.equal(motivoErrorDb(e('42P01', 'relation "equipo" does not exist')).motivo, 'tabla_no_existe');
    assert.equal(motivoErrorDb(e('42501')).motivo, 'sin_permiso');
    assert.equal(motivoErrorDb(new TypeError('Invalid URL')).motivo, 'url_invalida');
    assert.equal(motivoErrorDb(e(undefined, 'self-signed certificate in certificate chain')).motivo, 'ssl');
  });
  it('lo desconocido no revela nada', () => {
    const r = motivoErrorDb(e('ZZ999', 'postgres://usuario:SECRETO@host/db'));
    assert.equal(r.motivo, 'desconocido');
    assert.ok(!JSON.stringify(r).includes('SECRETO'));
  });
});
