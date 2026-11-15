import {
  CRYPTO_SCOPES,
  CryptoError,
  type CryptoKeyView,
  type EncryptResult,
} from '@adonis-agora/crypto-core';
import { describe, expect, it } from 'vitest';
import { readCiphertext } from '../../src/crypto/ciphertext.js';
import { type CryptoPrincipal, CryptoService } from '../../src/crypto/service.js';
import { verify as kitVerify, sealTo } from '../../src/crypto-kit/index.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { memoryCrypto, seedKeys, testKeyring } from '../../src/testing/index.js';

const at = '2026-02-02T02:02:02.000Z';

function fresh() {
  const crypto = memoryCrypto({ now: () => at });
  return crypto;
}

async function encrypt(
  service: CryptoService,
  principal: CryptoPrincipal,
  key: string,
  plaintext: string,
  aad?: string,
) {
  return service.encrypt(principal, { key, plaintext, ...(aad ? { aad } : {}) });
}

describe('keys', () => {
  it('creates each type, versions it and never exposes key material in the view', async () => {
    const { service, principal } = fresh();
    const symmetric = await service.createKey(principal, {
      name: 'orders',
      type: 'aes256-gcm',
      description: 'order payloads',
    });
    expect(symmetric).toMatchObject({
      partition: 'shop',
      name: 'orders',
      type: 'aes256-gcm',
      description: 'order payloads',
      latestVersion: 1,
      minDecryptionVersion: 1,
      deletionAllowed: false,
      exportable: false,
    });
    expect(symmetric.versions).toHaveLength(1);
    expect(symmetric.versions[0]).toMatchObject({
      version: 1,
      status: 'latest',
      createdBy: 'test',
    });
    expect(JSON.stringify(symmetric)).not.toMatch(/material|sealed/);

    const x25519 = await service.createKey(principal, { name: 'inbox', type: 'x25519' });
    expect(x25519.versions[0]?.kid).toBeTypeOf('string');
    expect(x25519.versions[0]?.publicKey?.crv).toBe('X25519');
    expect(x25519.versions[0]?.publicKey).not.toHaveProperty('d');

    const ed25519 = await service.createKey(principal, { name: 'webhook', type: 'ed25519' });
    expect(ed25519.versions[0]?.publicKey?.crv).toBe('Ed25519');
    await service.createKey(principal, { name: 'session', type: 'hmac-sha256' });
  });

  it('refuses a duplicate name, an invalid name and an unknown type', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    await expect(
      service.createKey(principal, { name: 'orders', type: 'aes256-gcm' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      service.createKey(principal, { name: 'Orders', type: 'aes256-gcm' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      service.createKey(principal, { name: 'nope', type: 'rsa' as never }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('lists and pages keys with search and sort', async () => {
    const crypto = fresh();
    await seedKeys(crypto);
    const page = await crypto.service.listKeys(crypto.principal, { page: 1, size: 2 });
    expect(page.meta).toMatchObject({ total: 5, perPage: 2, currentPage: 1, lastPage: 3 });
    expect(page.data.map((key) => key.name)).toEqual(['inbox', 'orders']);

    const filtered = await crypto.service.listKeys(crypto.principal, {
      page: 1,
      size: 50,
      search: 'web',
    });
    expect(filtered.data.map((key) => key.name)).toEqual(['webhook']);

    const desc = await crypto.service.listKeys(crypto.principal, {
      page: 1,
      size: 5,
      sort: { field: 'name', direction: 'desc' },
    });
    expect(desc.data[0]?.name).toBe('webhook');
  });
});

describe('aes256-gcm', () => {
  it('encrypts and decrypts, and the ciphertext names its key and version', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const encrypted = await encrypt(service, principal, 'orders', 'card 4242');
    expect(encrypted).toMatchObject({ key: 'orders', version: 1 });
    expect(encrypted.ciphertext.startsWith('agora:ct1:orders:1:')).toBe(true);
    expect(encrypted.ciphertext).not.toContain('card 4242');
    expect(readCiphertext(encrypted.ciphertext)).toEqual({ key: 'orders', version: 1 });
    const decrypted = await service.decrypt(principal, {
      key: 'orders',
      ciphertext: encrypted.ciphertext,
    });
    expect(decrypted).toEqual({ key: 'orders', version: 1, plaintext: 'card 4242' });
  });

  it('binds the aad: another aad does not open', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const encrypted = await encrypt(service, principal, 'orders', 'secret', 'row-1');
    await expect(
      service.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      service.decrypt(principal, {
        key: 'orders',
        ciphertext: encrypted.ciphertext,
        aad: 'row-2',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      service.decrypt(principal, {
        key: 'orders',
        ciphertext: encrypted.ciphertext,
        aad: 'row-1',
      }),
    ).resolves.toMatchObject({ plaintext: 'secret' });
  });

  it('refuses a tampered ciphertext', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const { ciphertext } = await encrypt(service, principal, 'orders', 'tamper me');
    // Flip one byte of the decoded payload, re-encode it: deterministic tampering.
    const [prefix, key, version, body] = ciphertext.split(':');
    const bytes = Buffer.from(body ?? '', 'base64url');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    const tampered = `${prefix}:${key}:${version}:${bytes.toString('base64url')}`;
    await expect(
      service.decrypt(principal, { key: 'orders', ciphertext: tampered }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses a ciphertext from another key', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'a', type: 'aes256-gcm' });
    await service.createKey(principal, { name: 'b', type: 'aes256-gcm' });
    const { ciphertext } = await encrypt(service, principal, 'a', 'x');
    await expect(service.decrypt(principal, { key: 'b', ciphertext })).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('rotation', () => {
  it('keeps old versions decryptable down to minDecryptionVersion, and rewrap moves to the latest', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const first = await encrypt(service, principal, 'orders', 'v1 value');
    const rotated = await service.rotateKey(principal, 'orders');
    expect(rotated.latestVersion).toBe(2);
    expect(rotated.versions.map((version) => version.status)).toEqual(['decryptable', 'latest']);

    // The old ciphertext still opens with its own (retired-but-allowed) version.
    expect(
      await service.decrypt(principal, { key: 'orders', ciphertext: first.ciphertext }),
    ).toMatchObject({ plaintext: 'v1 value', version: 1 });

    const rewrapped = await service.rewrap(principal, {
      key: 'orders',
      ciphertext: first.ciphertext,
    });
    expect(rewrapped).toMatchObject({ key: 'orders', version: 2 });
    expect(rewrapped).not.toHaveProperty('plaintext');
    expect(readCiphertext(rewrapped.ciphertext)?.version).toBe(2);
    expect(
      await service.decrypt(principal, { key: 'orders', ciphertext: rewrapped.ciphertext }),
    ).toMatchObject({ plaintext: 'v1 value' });

    // Retire version 1: its ciphertext no longer decrypts, and the key view says so.
    const policy = await service.updateKeyPolicy(principal, 'orders', { minDecryptionVersion: 2 });
    expect(policy.versions.map((version) => version.status)).toEqual(['retired', 'latest']);
    await expect(
      service.decrypt(principal, { key: 'orders', ciphertext: first.ciphertext }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      service.rewrap(principal, { key: 'orders', ciphertext: first.ciphertext }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('can encrypt with an older version explicitly, and refuses a retired one', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    await service.rotateKey(principal, 'orders');
    const old = await service.encrypt(principal, { key: 'orders', plaintext: 'old', version: 1 });
    expect(old.version).toBe(1);
    await service.updateKeyPolicy(principal, 'orders', { minDecryptionVersion: 2 });
    await expect(
      service.encrypt(principal, { key: 'orders', plaintext: 'old', version: 1 }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      service.encrypt(principal, { key: 'orders', plaintext: 'future', version: 9 }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('x25519', () => {
  it('seals to the key and opens with it, across a rotation by kid', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'inbox', type: 'x25519' });
    const encrypted = await encrypt(service, principal, 'inbox', 'hello inbox', 'row');
    expect(encrypted.ciphertext.startsWith('agora:pk1:')).toBe(true);
    expect(
      await service.decrypt(principal, {
        key: 'inbox',
        ciphertext: encrypted.ciphertext,
        aad: 'row',
      }),
    ).toMatchObject({ plaintext: 'hello inbox', version: 1 });

    await service.rotateKey(principal, 'inbox');
    const second = await encrypt(service, principal, 'inbox', 'after rotation');
    expect(second.version).toBe(2);
    // The old ciphertext still opens: its kid names the old version.
    expect(
      await service.decrypt(principal, {
        key: 'inbox',
        ciphertext: encrypted.ciphertext,
        aad: 'row',
      }),
    ).toMatchObject({ version: 1 });

    const rewrapped = await service.rewrap(principal, {
      key: 'inbox',
      ciphertext: encrypted.ciphertext,
      aad: 'row',
    });
    expect(rewrapped.version).toBe(2);
    expect(
      await service.decrypt(principal, {
        key: 'inbox',
        ciphertext: rewrapped.ciphertext,
        aad: 'row',
      }),
    ).toMatchObject({ plaintext: 'hello inbox' });
  });

  it('exposes the public key and a JWKS with every version, and seals with openWith', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'inbox', type: 'x25519' });
    const publicKey = await service.publicKey(principal, 'inbox');
    expect(publicKey.type).toBe('x25519');
    expect(publicKey.jwks.keys).toHaveLength(1);
    // A caller holding only the public JWK can seal; the server opens it with the private half.
    const sealed = sealTo(publicKey.jwk, 'outside', {});
    expect(await service.decrypt(principal, { key: 'inbox', ciphertext: sealed })).toMatchObject({
      plaintext: 'outside',
    });

    await service.rotateKey(principal, 'inbox');
    const jwks = await service.jwks(principal, 'inbox');
    expect(jwks.keys).toHaveLength(2);
    // Newest first, so a discovery document leads with the current key.
    expect(jwks.keys[0]?.kid).toBe((await service.publicKey(principal, 'inbox')).kid);
  });
});

describe('ed25519', () => {
  it('signs and verifies, and signatures stay valid across a rotation', async () => {
    const { service, principal } = fresh();
    const created = await service.createKey(principal, { name: 'webhook', type: 'ed25519' });
    const firstPublic = await service.publicKey(principal, 'webhook');
    const signature = await service.sign(principal, { key: 'webhook', message: 'body' });
    expect(signature.kid).toBe(created.versions[0]?.kid);
    expect(signature.signature.startsWith(`agora:sig1:${signature.kid}:`)).toBe(true);
    expect(
      await service.verify(principal, {
        key: 'webhook',
        message: 'body',
        signature: signature.signature,
      }),
    ).toEqual({ key: 'webhook', valid: true });
    expect(
      await service.verify(principal, {
        key: 'webhook',
        message: 'other',
        signature: signature.signature,
      }),
    ).toEqual({ key: 'webhook', valid: false });
    expect(
      await service.verify(principal, { key: 'webhook', message: 'body', signature: 'nope' }),
    ).toEqual({ key: 'webhook', valid: false });

    await service.rotateKey(principal, 'webhook');
    // Verification accepts every version's public key.
    expect(
      await service.verify(principal, {
        key: 'webhook',
        message: 'body',
        signature: signature.signature,
      }),
    ).toMatchObject({ valid: true });

    // The kit verifies the same signature with the public key the server published for it.
    expect(kitVerify(firstPublic.jwk, 'body', signature.signature)).toBe(true);
    const jwks = await service.jwks(principal, 'webhook');
    expect(kitVerify(jwks, 'body', signature.signature)).toBe(true);
  });

  it('signs base64url bytes and refuses an unsupported key', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'webhook', type: 'ed25519' });
    const signature = await service.sign(principal, {
      key: 'webhook',
      message: Buffer.from('raw').toString('base64url'),
      encoding: 'base64url',
    });
    expect(
      await service.verify(principal, {
        key: 'webhook',
        message: Buffer.from('raw').toString('base64url'),
        encoding: 'base64url',
        signature: signature.signature,
      }),
    ).toMatchObject({ valid: true });
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    await expect(service.sign(principal, { key: 'orders', message: 'x' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('hmac-sha256', () => {
  it('returns a stable digest for the same key version', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'session', type: 'hmac-sha256' });
    const first = await service.hmac(principal, { key: 'session', message: 'abc' });
    const second = await service.hmac(principal, { key: 'session', message: 'abc' });
    expect(first.hmac).toBe(second.hmac);
    expect(first.hmac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const other = await service.hmac(principal, { key: 'session', message: 'abd' });
    expect(other.hmac).not.toBe(first.hmac);
  });
});

describe('data keys', () => {
  it('returns plaintext plus wrapped, or wrapped only', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'root', type: 'aes256-gcm' });
    const withPlaintext = await service.generateDataKey(principal, { key: 'root' });
    expect(withPlaintext.plaintext).toBeTypeOf('string');
    expect(Buffer.from(withPlaintext.plaintext!, 'base64url')).toHaveLength(32);
    expect(withPlaintext.wrapped.startsWith('agora:ct1:root:1:')).toBe(true);
    // The wrapped data key opens back to the same plaintext data key.
    expect(
      await service.decrypt(principal, { key: 'root', ciphertext: withPlaintext.wrapped }),
    ).toMatchObject({ plaintext: withPlaintext.plaintext });

    const wrappedOnly = await service.generateDataKey(principal, { key: 'root', plaintext: false });
    expect(wrappedOnly).not.toHaveProperty('plaintext');
    expect(wrappedOnly.wrapped).toBeTypeOf('string');

    await service.createKey(principal, { name: 'inbox', type: 'x25519' });
    await expect(service.generateDataKey(principal, { key: 'inbox' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('authorization', () => {
  it('refuses an operation without its capability, and audits the refusal', async () => {
    const crypto = fresh();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    const reader: CryptoPrincipal = {
      partition: 'shop',
      capabilities: ['crypto:decrypt:orders'],
      actor: 'svc:reader',
    };
    await expect(
      crypto.service.encrypt(reader, { key: 'orders', plaintext: 'x' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 10 });
    expect(audit.data.find((row) => row.result === 'denied')).toMatchObject({
      operation: 'encrypt',
      key: 'orders',
      result: 'denied',
      actor: 'svc:reader',
    });
    // The capability it does hold works, and is audited as ok.
    const { ciphertext } = await encrypt(crypto.service, crypto.principal, 'orders', 'x');
    expect(await crypto.service.decrypt(reader, { key: 'orders', ciphertext })).toMatchObject({
      plaintext: 'x',
    });
  });

  it('honours wildcards and never implies one operation from another', async () => {
    const crypto = fresh();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    const star: CryptoPrincipal = { partition: 'shop', capabilities: ['crypto:*'], actor: 'svc' };
    await expect(encrypt(crypto.service, star, 'orders', 'x')).resolves.toBeDefined();
    const keysOnly: CryptoPrincipal = {
      partition: 'shop',
      capabilities: [CRYPTO_SCOPES.keysRead],
      actor: 'svc',
    };
    await expect(encrypt(crypto.service, keysOnly, 'orders', 'x')).rejects.toBeInstanceOf(
      CryptoError,
    );
    await expect(crypto.service.listKeys(keysOnly, { page: 1, size: 10 })).resolves.toBeDefined();
  });

  it('gates key management and export on their own capabilities', async () => {
    const crypto = fresh();
    const operator: CryptoPrincipal = {
      partition: 'shop',
      capabilities: [CRYPTO_SCOPES.keysRead],
      actor: 'op',
    };
    await expect(
      crypto.service.createKey(operator, { name: 'orders', type: 'aes256-gcm' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const manager: CryptoPrincipal = {
      partition: 'shop',
      capabilities: [CRYPTO_SCOPES.keysManage, CRYPTO_SCOPES.keysRead],
      actor: 'op',
    };
    const created = await crypto.service.createKey(manager, { name: 'orders', type: 'aes256-gcm' });
    expect(created.exportable).toBe(false);
    await expect(crypto.service.exportKey(manager, 'orders')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await crypto.service.updateKeyPolicy(manager, 'orders', { exportable: true });
    // The manage capability alone still cannot export.
    await expect(crypto.service.exportKey(manager, 'orders')).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});

describe('partition isolation', () => {
  it('keeps the same key name separate per app and refuses a ciphertext from another app', async () => {
    const crypto = fresh();
    const billing: CryptoPrincipal = {
      partition: 'billing',
      capabilities: ['crypto:*'],
      actor: 'test',
    };
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await crypto.service.createKey(billing, { name: 'orders', type: 'aes256-gcm' });
    const shopCiphertext = await encrypt(crypto.service, crypto.principal, 'orders', 'shop');
    const billingCiphertext = await encrypt(crypto.service, billing, 'orders', 'billing');
    expect(
      await crypto.service.decrypt(billing, {
        key: 'orders',
        ciphertext: billingCiphertext.ciphertext,
      }),
    ).toMatchObject({ plaintext: 'billing' });
    // Same key name, different app: the other app's ciphertext does not open.
    await expect(
      crypto.service.decrypt(billing, { key: 'orders', ciphertext: shopCiphertext.ciphertext }),
    ).rejects.toMatchObject({ code: 'invalid' });
    // Neither app sees the other's keys.
    const shopKeys = await crypto.service.listKeys(crypto.principal, { page: 1, size: 10 });
    const billingKeys = await crypto.service.listKeys(billing, { page: 1, size: 10 });
    expect(shopKeys.data).toHaveLength(1);
    expect(billingKeys.data).toHaveLength(1);
    expect(shopKeys.data[0]?.partition).toBe('shop');
  });
});

describe('lifecycle', () => {
  it('deletes only when allowed, destroys the material and audits it', async () => {
    const crypto = fresh();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await expect(crypto.service.deleteKey(crypto.principal, 'orders')).rejects.toMatchObject({
      code: 'forbidden',
    });
    await crypto.service.updateKeyPolicy(crypto.principal, 'orders', { deletionAllowed: true });
    expect(await crypto.service.deleteKey(crypto.principal, 'orders')).toEqual({
      key: 'orders',
      deleted: true,
    });
    await expect(
      crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'x' }),
    ).rejects.toMatchObject({ code: 'deleted' });
    // The name stays reserved, so a deleted key is never silently a new key.
    await expect(
      crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const versions = await crypto.store.versions('shop', 'orders');
    expect(versions).toHaveLength(0);
    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 10 });
    expect(audit.data.some((row) => row.operation === 'delete' && row.result === 'ok')).toBe(true);
  });

  it('exports only an exportable key, and exports the material for its version', async () => {
    const crypto = fresh();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await expect(crypto.service.exportKey(crypto.principal, 'orders')).rejects.toMatchObject({
      code: 'not_exportable',
    });
    await crypto.service.updateKeyPolicy(crypto.principal, 'orders', { exportable: true });
    const exported = await crypto.service.exportKey(crypto.principal, 'orders');
    expect(exported.version).toBe(1);
    expect(Buffer.from(exported.material as string, 'base64url')).toHaveLength(32);

    const key = await crypto.service.createKey(crypto.principal, {
      name: 'inbox',
      type: 'x25519',
      exportable: true,
    });
    const privateJwk = await crypto.service.exportKey(crypto.principal, 'inbox');
    expect(privateJwk.kid).toBe(key.versions[0]?.kid);
    expect((privateJwk.material as { d?: string }).d).toBeTypeOf('string');
    // The audit never recorded the material.
    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 50 });
    expect(JSON.stringify(audit.data)).not.toContain((privateJwk.material as { d: string }).d);
  });

  it('refuses a deleted key list entry and reports it in the view', async () => {
    const crypto = fresh();
    await crypto.service.createKey(crypto.principal, {
      name: 'orders',
      type: 'aes256-gcm',
      deletionAllowed: true,
    });
    await crypto.service.deleteKey(crypto.principal, 'orders');
    const view: CryptoKeyView = await crypto.service.getKey(crypto.principal, 'orders');
    expect(view.deletedAt).toBeTypeOf('string');
    expect(view.versions).toHaveLength(0);
    expect(view.minDecryptionVersion).toBe(2);
  });
});

describe('batch', () => {
  it('runs every item and reports the index of a failure', async () => {
    const { service, principal } = fresh();
    await service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const batch = await service.encryptBatch(principal, [
      { key: 'orders', plaintext: 'a' },
      { key: 'orders', plaintext: 'b' },
    ]);
    expect(batch.results).toHaveLength(2);
    const decrypted = await service.decryptBatch(
      principal,
      batch.results.map((result) => ({ key: result.key, ciphertext: result.ciphertext })),
    );
    expect(decrypted.results.map((result) => result.plaintext)).toEqual(['a', 'b']);
    await expect(
      service.encryptBatch(principal, [
        { key: 'orders', plaintext: 'a' },
        { key: 'missing', plaintext: 'b' },
      ]),
    ).rejects.toThrow(/batch item 1 failed/);
    await expect(service.encryptBatch(principal, 'nope' as never)).rejects.toMatchObject({
      code: 'invalid',
    });
  });
});

describe('audit trail', () => {
  it('records who, app, key, version, operation and result, never plaintext', async () => {
    const crypto = fresh();
    const principal: CryptoPrincipal = {
      partition: 'shop',
      capabilities: ['crypto:*'],
      actor: 'user:42',
      clientId: 'svc:streaming',
    };
    await crypto.service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const encrypted: EncryptResult = await crypto.service.encrypt(principal, {
      key: 'orders',
      plaintext: 'never in the audit',
    });
    await crypto.service.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext });
    const page = await crypto.service.audit(principal, { page: 1, size: 10 });
    expect(page.meta.total).toBeGreaterThanOrEqual(3);
    const decrypt = page.data.find((row) => row.operation === 'decrypt');
    expect(decrypt).toMatchObject({
      partition: 'shop',
      key: 'orders',
      version: 1,
      operation: 'decrypt',
      result: 'ok',
      actor: 'user:42',
      clientId: 'svc:streaming',
    });
    expect(JSON.stringify(page.data)).not.toContain('never in the audit');

    const filtered = await crypto.service.audit(principal, {
      page: 1,
      size: 10,
      filters: { operation: 'decrypt', result: 'ok' },
    });
    expect(filtered.data).toHaveLength(1);
  });

  it('summarizes the last 24h for the console', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'x' });
    const overview = await crypto.service.overview(crypto.principal);
    expect(overview).toMatchObject({ partition: 'shop', keys: 1, versions: 1, operations24h: 2 });
    expect(overview.lastOperationAt).toBeTypeOf('string');
  });
});

describe('service wiring', () => {
  it('boots from a memory store and a fixed keyring, and reports identity', async () => {
    const store = new MemoryStore();
    const service = new CryptoService({ store, keyring: testKeyring() });
    const principal: CryptoPrincipal = {
      partition: 'shop',
      capabilities: ['crypto:*'],
      actor: 'test',
      clientId: 'svc',
    };
    expect(service.whoami(principal)).toEqual({
      resource: 'urn:agora:crypto',
      partition: 'shop',
      capabilities: ['crypto:*'],
      clientId: 'svc',
    });
    await expect(service.getKey(principal, 'nope')).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      service.createKey({ ...principal, partition: '' }, { name: 'x', type: 'aes256-gcm' }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});
