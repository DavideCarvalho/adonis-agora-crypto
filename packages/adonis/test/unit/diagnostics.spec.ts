import diagnostics_channel from 'node:diagnostics_channel';
import '@adonis-agora/diagnostics';
import {
  newTransportMessageId,
  TRANSPORT_MESSAGE_VERSION,
  type TransportOperation,
} from '@adonis-agora/crypto-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CryptoPrincipal } from '../../src/crypto/service.js';
import { CRYPTO_DIAGNOSTIC_EVENTS } from '../../src/diagnostics.js';
import { localOperations } from '../../src/operations.js';
import { MemoryDataKeyStore } from '../../src/subjects/store.js';
import { SubjectKeys } from '../../src/subjects/subject_keys.js';
import { memoryCrypto } from '../../src/testing/index.js';
import { createCryptoRpc } from '../../src/transports/rpc.js';

interface Envelope {
  lib: string;
  event: string;
  app?: string;
  durationMs?: number;
  payload: Record<string, unknown>;
}

let seen: Envelope[] = [];
const listener = (message: unknown) => {
  seen.push(message as Envelope);
};

beforeEach(() => {
  seen = [];
  for (const event of CRYPTO_DIAGNOSTIC_EVENTS) {
    diagnostics_channel.subscribe(`agora:crypto:${event}`, listener);
  }
});

afterEach(() => {
  for (const event of CRYPTO_DIAGNOSTIC_EVENTS) {
    diagnostics_channel.unsubscribe(`agora:crypto:${event}`, listener);
  }
});

const events = () => seen.map((entry) => entry.event);

/** A control plane: the service, reached by tenants through the transport with their tokens. */
function controlPlane() {
  const crypto = memoryCrypto({ partition: 'billing' });
  const rpc = createCryptoRpc({
    service: crypto.service,
    verifyTenant: ({ token }) => {
      if (token === 'billing-token') return { partition: 'billing', capabilities: ['crypto:*'] };
      if (token === 'reader-token') {
        return { partition: 'billing', capabilities: ['crypto:keys:read'], actor: 'reader' };
      }
      return null;
    },
  });
  const call = async (token: string, operation: TransportOperation, input: unknown) => {
    const reply = await rpc.handle({
      v: TRANSPORT_MESSAGE_VERSION,
      id: newTransportMessageId(),
      operation,
      input,
      token,
      issuedAt: Date.now(),
    });
    return reply as { ok: boolean; result?: Record<string, unknown>; error?: { code: string } };
  };
  return { crypto, call };
}

describe('diagnostics events', () => {
  it('a control plane emits each operation with app = the tenant of the verified token', async () => {
    const { call } = controlPlane();
    await call('billing-token', 'keys.create', { name: 'orders', type: 'aes256-gcm' });
    const sealed = await call('billing-token', 'encrypt', { key: 'orders', plaintext: 'héllo' });
    await call('billing-token', 'decrypt', {
      key: 'orders',
      ciphertext: sealed.result?.ciphertext,
    });
    await call('billing-token', 'keys.rotate', { name: 'orders' });

    expect(events()).toEqual(['keys.create', 'encrypt', 'decrypt', 'keys.rotate']);
    for (const entry of seen) {
      expect(entry.lib).toBe('crypto');
      expect(entry.app).toBe('billing');
      expect(typeof entry.durationMs).toBe('number');
    }
    expect(seen[1]!.payload).toEqual({
      app: 'billing',
      key: 'orders',
      version: 1,
      outcome: 'ok',
      actor: expect.any(String),
      durationMs: expect.any(Number),
      bytes: Buffer.byteLength('héllo'),
    });
  });

  it('reports a failure by its code and a refusal as `denied`', async () => {
    const { call } = controlPlane();
    await call('billing-token', 'decrypt', { key: 'missing', ciphertext: 'agora:ct1:x' });
    await call('reader-token', 'encrypt', { key: 'orders', plaintext: 'x' });

    expect(seen[0]).toMatchObject({
      event: 'decrypt',
      app: 'billing',
      payload: { key: 'missing', outcome: 'error', errorCode: 'not_found' },
    });
    expect(seen[0]!.payload).not.toHaveProperty('error');
    expect(seen[1]).toMatchObject({
      event: 'denied',
      app: 'billing',
      payload: {
        op: 'encrypt',
        key: 'orders',
        capability: 'crypto:encrypt:orders',
        errorCode: 'forbidden',
        actor: 'reader',
      },
    });
  });

  it('a standalone app emits with its own partition', async () => {
    const crypto = memoryCrypto({ partition: 'shop' });
    await crypto.service.createKey(crypto.principal, { name: 'files', type: 'aes256-gcm' });
    await crypto.service.generateDataKey(crypto.principal, { key: 'files' });
    expect(seen.map((entry) => [entry.event, entry.app])).toEqual([
      ['keys.create', 'shop'],
      ['datakey', 'shop'],
    ]);
  });

  it('reads publish nothing', async () => {
    const crypto = memoryCrypto();
    await crypto.service.listKeys(crypto.principal, { page: 1, size: 10 });
    await crypto.service.overview(crypto.principal);
    expect(seen).toEqual([]);
  });

  it('a tenant leaves operations to the control plane and reports only its cache misses', async () => {
    const server = memoryCrypto({ partition: 'research' });
    // The tenant's operations reach the control plane's service (as a transport would).
    const subjects = new SubjectKeys({
      app: 'research',
      operations: localOperations(server.service, server.principal),
      store: new MemoryDataKeyStore(),
    });
    const subject = { type: 'researcher', id: 7 };
    const sealed = await subjects.encrypt(subject, 'secret notes');
    await subjects.encrypt(subject, 'more notes');
    await subjects.decrypt(sealed, { subject });

    const byOrigin = seen.map((entry) =>
      entry.event === 'subjects.cache'
        ? `${entry.event}:${entry.payload.op}:${entry.payload.outcome}`
        : entry.event,
    );
    // keys.create / datakey come from the service (the control plane); the tenant adds no
    // `encrypt`/`decrypt` of its own (values are sealed locally), only the cache misses it alone
    // sees. Hits (the second encrypt, the decrypt) publish nothing.
    expect(byOrigin).toEqual(['subjects.cache:encrypt:miss', 'datakey', 'keys.create', 'datakey']);
    expect(seen.every((entry) => entry.app === 'research')).toBe(true);
    expect(seen.find((entry) => entry.event === 'subjects.cache')!.payload).toEqual({
      app: 'research',
      key: 'subject_researcher_7',
      op: 'encrypt',
      outcome: 'miss',
    });
  });

  it('reports a decrypt miss once the data key left the cache, and never a hit', async () => {
    const server = memoryCrypto({ partition: 'research' });
    const subjects = new SubjectKeys({
      app: 'research',
      operations: localOperations(server.service, server.principal),
      store: new MemoryDataKeyStore(),
    });
    const subject = { type: 'researcher', id: 8 };
    const sealed = await subjects.encrypt(subject, 'x');
    await subjects.decrypt(sealed, { subject });
    subjects.evict(subject);
    seen = [];
    await subjects.decrypt(sealed, { subject });
    await subjects.decrypt(sealed, { subject });
    expect(seen.map((entry) => [entry.event, entry.payload.op, entry.payload.outcome])).toEqual([
      ['subjects.cache', 'decrypt', 'miss'],
      ['decrypt', undefined, 'ok'],
    ]);
  });

  it('forget reports the local shredding next to the control plane delete', async () => {
    const server = memoryCrypto({ partition: 'research' });
    const subjects = new SubjectKeys({
      app: 'research',
      operations: localOperations(server.service, server.principal),
      store: new MemoryDataKeyStore(),
    });
    const subject = { type: 'researcher', id: 9 };
    await subjects.encrypt(subject, 'x');
    seen = [];
    await subjects.forget(subject);
    expect(events()).toEqual(['keys.delete', 'subjects.forget']);
    expect(seen[1]!.payload).toEqual({
      app: 'research',
      key: 'subject_researcher_9',
      outcome: 'ok',
      dataKeys: 1,
      durationMs: expect.any(Number),
    });
  });

  it('drops an invalid key name from the payload', async () => {
    const crypto = memoryCrypto();
    await crypto.service
      .encrypt(crypto.principal, { key: 'Not A Key!', plaintext: 'x' })
      .catch(() => {});
    expect(seen[0]).toMatchObject({ event: 'encrypt', payload: { key: '<invalid>' } });
  });

  it('never puts plaintext, ciphertext, key material, aad or audit context in an event', async () => {
    const crypto = memoryCrypto({ partition: 'vault' });
    const principal: CryptoPrincipal = crypto.principal;
    const secrets: string[] = [];
    const remember = <T>(value: T): T => {
      if (typeof value === 'string') secrets.push(value);
      return value;
    };
    const plaintext = remember('plaintext-canary-7f3a');
    const aad = remember('aad-canary-91bc');
    const context = remember('context-canary-55de');

    await crypto.service.createKey(principal, {
      name: 'orders',
      type: 'aes256-gcm',
      exportable: true,
    });
    await crypto.service.createKey(principal, { name: 'inbox', type: 'x25519' });
    await crypto.service.createKey(principal, { name: 'signer', type: 'ed25519' });
    await crypto.service.createKey(principal, { name: 'mac', type: 'hmac-sha256' });

    const sealed = await crypto.service.encrypt(principal, { key: 'orders', plaintext, aad });
    remember(sealed.ciphertext);
    await crypto.service.decrypt(principal, {
      key: 'orders',
      ciphertext: sealed.ciphertext,
      aad,
      context,
    });
    // A wrong aad fails: the error must not leak the aad either.
    await crypto.service
      .decrypt(principal, { key: 'orders', ciphertext: sealed.ciphertext, aad: 'aad-canary-wrong' })
      .catch(() => {});
    secrets.push('aad-canary-wrong');
    const rewrapped = await crypto.service.rewrap(principal, {
      key: 'orders',
      ciphertext: sealed.ciphertext,
      aad,
      context,
    });
    remember(rewrapped.ciphertext);
    const sealedTo = await crypto.service.encrypt(principal, { key: 'inbox', plaintext });
    remember(sealedTo.ciphertext);
    await crypto.service.decrypt(principal, { key: 'inbox', ciphertext: sealedTo.ciphertext });
    const dataKey = await crypto.service.generateDataKey(principal, {
      key: 'orders',
      aad,
      context,
    });
    remember(dataKey.plaintext);
    remember(dataKey.wrapped);
    const signature = await crypto.service.sign(principal, { key: 'signer', message: plaintext });
    remember(signature.signature);
    await crypto.service.verify(principal, {
      key: 'signer',
      message: plaintext,
      signature: signature.signature,
    });
    const mac = await crypto.service.hmac(principal, { key: 'mac', message: plaintext });
    remember(mac.hmac);
    const exported = await crypto.service.exportKey(principal, 'orders');
    remember(exported.material);
    await crypto.service.rotateKey(principal, 'orders');

    const subjects = new SubjectKeys({
      app: 'vault',
      operations: localOperations(crypto.service, principal),
      store: new MemoryDataKeyStore(),
    });
    const subjectSealed = await subjects.encrypt({ type: 'user', id: 1 }, plaintext, { aad });
    remember(subjectSealed);
    await subjects.decrypt(subjectSealed, { subject: { type: 'user', id: 1 }, aad });
    await subjects
      .decrypt(subjectSealed, { subject: { type: 'user', id: 1 }, aad: 'aad-canary-wrong' })
      .catch(() => {});
    const stored = await subjects.store.page({ limit: 10 });
    for (const record of stored) {
      remember(record.wrapped);
      const cached = subjects.cache.get(record.id);
      if (cached) {
        remember(cached.bytes.toString('base64url'));
        remember(cached.bytes.toString('hex'));
      }
    }
    await subjects.forget({ type: 'user', id: 1 });

    expect(new Set(events())).toEqual(
      new Set([
        'keys.create',
        'encrypt',
        'decrypt',
        'rewrap',
        'datakey',
        'sign',
        'verify',
        'hmac',
        'keys.export',
        'keys.rotate',
        'subjects.cache',
        'keys.delete',
        'subjects.forget',
      ]),
    );
    const everything = JSON.stringify(seen);
    for (const secret of secrets) {
      expect(everything).not.toContain(secret);
      // Also no fragment long enough to be a key or a ciphertext body.
      for (const part of secret.split(':').filter((piece) => piece.length >= 16)) {
        expect(everything).not.toContain(part);
      }
    }
    for (const entry of seen) {
      expect(Object.keys(entry.payload)).not.toEqual(
        expect.arrayContaining(['plaintext', 'ciphertext', 'aad', 'context', 'material']),
      );
    }
  });

  it('emits nothing (and never throws) without diagnostics listening', async () => {
    for (const event of CRYPTO_DIAGNOSTIC_EVENTS) {
      diagnostics_channel.unsubscribe(`agora:crypto:${event}`, listener);
    }
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: 'orders', type: 'aes256-gcm' });
    await crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'x' });
    expect(seen).toEqual([]);
  });
});
