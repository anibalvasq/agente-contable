import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hmacSha256Valid, safeEqual, sharedSecretValid } from './signatures.js';

describe('safeEqual', () => {
  it('compara sin filtrar por tiempo', () => {
    assert.ok(safeEqual('abc', 'abc'));
    assert.ok(!safeEqual('abc', 'abd'));
    assert.ok(!safeEqual('abc', 'abcd'));
  });
});

describe('sharedSecretValid', () => {
  it('valida el secreto compartido', () => {
    assert.ok(sharedSecretValid('s3cr3t', 's3cr3t'));
    assert.ok(!sharedSecretValid('s3cr3t', 'otro'));
    assert.ok(!sharedSecretValid('s3cr3t', undefined));
    assert.ok(!sharedSecretValid(5, 's3cr3t'));
  });
});

describe('hmacSha256Valid', () => {
  it('valida la firma HMAC del body crudo', () => {
    const raw = Buffer.from('{"a":1}');
    const sig = 'sha256=' + createHmac('sha256', 'secret').update(raw).digest('hex');
    assert.ok(hmacSha256Valid(raw, sig, 'secret'));
    assert.ok(!hmacSha256Valid(raw, sig, 'otro-secreto'));
    assert.ok(!hmacSha256Valid(raw, 123, 'secret'));
  });
});
