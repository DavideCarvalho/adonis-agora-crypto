import { CryptoClientError } from '@adonis-agora/crypto-core';
import { describe, expect, it, vi } from 'vitest';
import { localOperations } from '../../src/operations.js';
import { DataKeyCache } from '../../src/subjects/cache.js';
import {
  openWithDataKey,
  readSubjectCiphertext,
  SUBJECT_CIPHERTEXT_PREFIX,
  sealWithDataKey,
} from '../../src/subjects/ciphertext.js';
import { SubjectKeyError } from '../../src/subjects/errors.js';
import { MemoryDataKeyStore } from '../../src/subjects/store.js';
import { type SubjectKeyOperations, SubjectKeys } from '../../src/subjects/subject_keys.js';
import { memoryCrypto, memorySubjectKeys } from '../../src/testing/index.js';

/** Operations that count calls and can be switched off like an unreachable control plane. */
function flaky(operations: SubjectKeyOperations) {
  const calls: string[] = [];
  let down = false;
  const wrap = <K extends keyof SubjectKeyOperations>(name: K) =>
    (async (...args: unknown[]) => {
      calls.push(name);
      if (down) throw new CryptoClientError(0, 'network', 'crypto: fetch failed: ECONNREFUSED');
      return (operations[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as SubjectKeyOperations[K];
  const ops: SubjectKeyOperations = {
    generateDataKey: wrap('generateDataKey'),
    decrypt: wrap('decrypt'),
    rewrap: wrap('rewrap'),
    createKey: wrap('createKey'),
    deleteKey: wrap('deleteKey'),
    getKey: wrap('getKey'),
  };
  return {
    ops,
    calls,
    setDown(value: boolean) {
      down = value;
    },
  };
}

function setup(options: { cache?: ConstructorParameters<typeof DataKeyCache>[0] | false } = {}) {
  const crypto = memoryCrypto();
  const store = new MemoryDataKeyStore();
  const remote = flaky(localOperations(crypto.service, crypto.principal));
  const subjects = new SubjectKeys({
    operations: remote.ops,
    store,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
  });
  return { crypto, store, remote, subjects };
}

async function rejection(promise: Promise<unknown>): Promise<SubjectKeyError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubjectKeyError);
    return error as SubjectKeyError;
  }
  throw new Error('expected a rejection');
}

describe('subject ciphertext', () => {
  const key = Buffer.alloc(32, 7);
  const context = { key: 'subject_1', dataKeyId: 'a'.repeat(32), aad: 'row:1' };

  it('round-trips and is self-describing', () => {
    const sealed = sealWithDataKey(key, 'héllo', context);
    expect(sealed.startsWith(`${SUBJECT_CIPHERTEXT_PREFIX}subject_1:${'a'.repeat(32)}:`)).toBe(
      true,
    );
    expect(readSubjectCiphertext(sealed)).toEqual({ key: 'subject_1', dataKeyId: 'a'.repeat(32) });
    expect(openWithDataKey(key, sealed, context)).toBe('héllo');
  });

  it('uses a fresh IV every time', () => {
    expect(sealWithDataKey(key, 'x', context)).not.toBe(sealWithDataKey(key, 'x', context));
  });

  it('refuses a tampered body, another aad, another data key and a wrong key', () => {
    const sealed = sealWithDataKey(key, 'secret', context);
    const body = sealed.slice(sealed.lastIndexOf(':') + 1);
    const bytes = Buffer.from(body, 'base64url');
    bytes[14] = (bytes[14] ?? 0) ^ 1;
    const tampered = `${sealed.slice(0, sealed.lastIndexOf(':') + 1)}${bytes.toString('base64url')}`;
    expect(() => openWithDataKey(key, tampered, context)).toThrow(SubjectKeyError);
    expect(() => openWithDataKey(key, sealed, { ...context, aad: 'row:2' })).toThrow(
      /did not open/,
    );
    expect(() => openWithDataKey(key, sealed, { ...context, dataKeyId: 'b'.repeat(32) })).toThrow(
      /another data key/,
    );
    expect(() => openWithDataKey(Buffer.alloc(32, 8), sealed, context)).toThrow(/did not open/);
    // The header is authenticated too: renaming the subject in the prefix fails.
    const renamed = sealed.replace('subject_1', 'subject_2');
    expect(() => openWithDataKey(key, renamed, { ...context, key: 'subject_2' })).toThrow(
      /did not open/,
    );
  });

  it('reads only well-formed values', () => {
    expect(readSubjectCiphertext('plain text')).toBeUndefined();
    expect(readSubjectCiphertext('agora:se1:Bad:abc:xyz')).toBeUndefined();
    expect(readSubjectCiphertext(`agora:se1:subject_1:${'a'.repeat(32)}`)).toBeUndefined();
    expect(readSubjectCiphertext(42)).toBeUndefined();
  });
});

describe('DataKeyCache', () => {
  it('evicts the least recently used entry and zeroes it', () => {
    const cache = new DataKeyCache({ maxEntries: 2, ttlMs: 1000 });
    cache.set('a', 'k', Buffer.alloc(32, 1));
    cache.set('b', 'k', Buffer.alloc(32, 2));
    const a = cache.get('a')!;
    cache.set('c', 'k', Buffer.alloc(32, 3));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(a);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(a.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('expires entries after the TTL (a hit does not extend it)', () => {
    let now = 0;
    const cache = new DataKeyCache({ maxEntries: 10, ttlMs: 100, now: () => now });
    cache.set('a', 'k', Buffer.alloc(32, 1), { current: true });
    const entry = cache.get('a')!;
    now = 99;
    expect(cache.current('k')?.id).toBe('a');
    now = 100;
    expect(cache.get('a')).toBeUndefined();
    expect(cache.current('k')).toBeUndefined();
    expect(entry.bytes.every((byte) => byte === 0)).toBe(true);
  });

  it('never hands out the buffer it holds', () => {
    const cache = new DataKeyCache();
    const source = Buffer.alloc(32, 9);
    const returned = cache.set('a', 'k', source);
    source.fill(0);
    returned.fill(0);
    expect(cache.get('a')!.bytes.every((byte) => byte === 9)).toBe(true);
  });

  it('evicts one subject key only', () => {
    const cache = new DataKeyCache();
    cache.set('a', 'k1', Buffer.alloc(32, 1), { current: true });
    cache.set('b', 'k2', Buffer.alloc(32, 2), { current: true });
    cache.evictKey('k1');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.current('k2')?.id).toBe('b');
  });
});

describe('SubjectKeys', () => {
  it('creates the subject key lazily, deletable, and round-trips', async () => {
    const { subjects, crypto } = setup();
    const sealed = await subjects.encrypt(42, 'notes about 42', { aad: 'notes:1' });
    expect(sealed.startsWith('agora:se1:subject_42:')).toBe(true);
    expect(await subjects.decrypt(sealed, { aad: 'notes:1', subject: 42 })).toBe('notes about 42');
    const key = await crypto.service.getKey(crypto.principal, 'subject_42');
    expect(key.deletionAllowed).toBe(true);
    expect(key.type).toBe('aes256-gcm');
  });

  it('makes no control-plane call in steady state', async () => {
    const { subjects, remote } = setup();
    const first = await subjects.encrypt('r1', 'a');
    const before = remote.calls.length;
    for (let i = 0; i < 20; i += 1) {
      await subjects.decrypt(await subjects.encrypt('r1', `v${i}`), { anySubject: true });
    }
    await subjects.decrypt(first, { anySubject: true });
    expect(remote.calls.length).toBe(before);
  });

  it('shares one data key per subject and stores it wrapped only', async () => {
    const { subjects, store } = setup();
    const a = readSubjectCiphertext(await subjects.encrypt(1, 'a'))!;
    const b = readSubjectCiphertext(await subjects.encrypt(1, 'b'))!;
    const other = readSubjectCiphertext(await subjects.encrypt(2, 'c'))!;
    expect(a.dataKeyId).toBe(b.dataKeyId);
    expect(other.dataKeyId).not.toBe(a.dataKeyId);
    const record = await store.get(a.dataKeyId);
    expect(record?.wrapped.startsWith('agora:ct1:subject_1:1:')).toBe(true);
  });

  it('runs one control-plane round trip for concurrent first writes', async () => {
    const { subjects, remote, store } = setup();
    await Promise.all(Array.from({ length: 10 }, (_, i) => subjects.encrypt(7, `v${i}`)));
    // One "no such key", one create, one data key: not ten of each.
    expect(remote.calls.filter((call) => call === 'createKey').length).toBe(1);
    expect(remote.calls.filter((call) => call === 'generateDataKey').length).toBe(2);
    expect((await store.page({ limit: 100 })).length).toBe(1);
  });

  it('works with the cache off (every operation asks the control plane)', async () => {
    const { subjects, remote } = setup({ cache: false });
    const sealed = await subjects.encrypt(3, 'x');
    const before = remote.calls.length;
    expect(await subjects.decrypt(sealed, { anySubject: true })).toBe('x');
    expect(remote.calls.length).toBe(before + 1);
    expect(subjects.cache.size).toBe(0);
  });

  it('keeps cached subjects working while the control plane is down, and fails the rest typed', async () => {
    const { subjects, remote } = setup();
    const cached = await subjects.encrypt('alice', 'hers');
    const uncached = await subjects.encrypt('bob', 'his');
    subjects.evict('bob');
    remote.setDown(true);

    expect(await subjects.decrypt(cached, { anySubject: true })).toBe('hers');
    expect(
      await subjects.decrypt(await subjects.encrypt('alice', 'more'), { anySubject: true }),
    ).toBe('more');

    const read = await rejection(subjects.decrypt(uncached, { anySubject: true }));
    expect(read.code).toBe('unavailable');
    expect(read.message).not.toContain('his');
    const write = await rejection(subjects.encrypt('carol', 'new'));
    expect(write.code).toBe('unavailable');

    remote.setDown(false);
    expect(await subjects.decrypt(uncached, { anySubject: true })).toBe('his');
  });

  it('fails when the TTL ran out and the control plane is down', async () => {
    let now = 0;
    const crypto = memoryCrypto();
    const remote = flaky(localOperations(crypto.service, crypto.principal));
    const subjects = new SubjectKeys({
      operations: remote.ops,
      store: new MemoryDataKeyStore(),
      cache: { ttlMs: 1000, now: () => now },
    });
    const sealed = await subjects.encrypt(1, 'x');
    remote.setDown(true);
    now = 999;
    expect(await subjects.decrypt(sealed, { anySubject: true })).toBe('x');
    now = 1000;
    expect((await rejection(subjects.decrypt(sealed, { anySubject: true }))).code).toBe(
      'unavailable',
    );
  });

  it('forget shreds the data: the key is deleted, data keys and cache are gone', async () => {
    const { subjects, store, crypto } = setup();
    const sealed = await subjects.encrypt(9, 'to be forgotten');
    const { dataKeyId } = readSubjectCiphertext(sealed)!;
    const result = await subjects.forget(9);
    expect(result).toMatchObject({ key: 'subject_9', forgotten: true, dataKeys: 1 });
    expect(await store.get(dataKeyId)).toBeNull();
    expect(subjects.cache.get(dataKeyId)).toBeUndefined();
    expect((await crypto.service.getKey(crypto.principal, 'subject_9')).deletedAt).toBeDefined();

    expect((await rejection(subjects.decrypt(sealed, { anySubject: true }))).code).toBe(
      'forgotten',
    );
    expect((await rejection(subjects.encrypt(9, 'again'))).code).toBe('forgotten');
    // Idempotent.
    await expect(subjects.forget(9)).resolves.toMatchObject({ forgotten: true, dataKeys: 0 });
  });

  it('forget of a subject that never wrote still forgets it', async () => {
    const { subjects } = setup();
    await subjects.forget('ghost');
    expect((await rejection(subjects.encrypt('ghost', 'x'))).code).toBe('forgotten');
  });

  it('even a stolen wrapped data key is useless after forget', async () => {
    const { subjects, store, crypto } = setup();
    const sealed = await subjects.encrypt(5, 'x');
    const { dataKeyId } = readSubjectCiphertext(sealed)!;
    const stolen = (await store.get(dataKeyId))!;
    await subjects.forget(5);
    await store.insert(stolen);
    subjects.clear();
    expect((await rejection(subjects.decrypt(sealed, { anySubject: true }))).code).toBe(
      'forgotten',
    );
    await expect(
      crypto.service.decrypt(crypto.principal, { key: 'subject_5', ciphertext: stolen.wrapped }),
    ).rejects.toThrow(/deleted/);
  });

  it('refuses a ciphertext moved to another subject or aad, and a wrapped key moved to another row', async () => {
    const { subjects, store } = setup();
    const sealed = await subjects.encrypt(1, 'one', { aad: 'a' });
    expect((await rejection(subjects.decrypt(sealed, { aad: 'b', subject: 1 }))).code).toBe(
      'invalid',
    );
    expect((await rejection(subjects.decrypt(sealed, { aad: 'a', subject: 2 }))).code).toBe(
      'invalid',
    );
    // Copy subject 1's wrapped data key into another id: it was wrapped with its own id as AAD.
    const { dataKeyId } = readSubjectCiphertext(sealed)!;
    const record = (await store.get(dataKeyId))!;
    const forged = sealed.replace(dataKeyId, 'f'.repeat(32));
    await store.insert({ ...record, id: 'f'.repeat(32) });
    subjects.clear();
    expect((await rejection(subjects.decrypt(forged, { aad: 'a', subject: 1 }))).code).toBe(
      'invalid',
    );
  });

  it('refuses plaintext and malformed values instead of returning them', async () => {
    const { subjects } = setup();
    expect((await rejection(subjects.decrypt('just text'))).code).toBe('invalid');
    expect((await rejection(subjects.decrypt('agora:se1:subject_1:zz:abc'))).code).toBe('invalid');
  });

  it('validates subject ids into key names', () => {
    const { subjects } = setup();
    expect(subjects.keyName(12)).toBe('subject_12');
    expect(subjects.keyName('0b6f5c1e-8a8b-4bd5-9d2b-6c1e0e9b7f10')).toBe(
      'subject_0b6f5c1e-8a8b-4bd5-9d2b-6c1e0e9b7f10',
    );
    expect(() => subjects.keyName('Has:Colon')).toThrow(SubjectKeyError);
    expect(() => subjects.keyName('')).toThrow(SubjectKeyError);
    expect(() => subjects.keyName('x'.repeat(80))).toThrow(SubjectKeyError);
  });

  it('createKeys: explicit refuses unknown subjects until create()', async () => {
    const { subjects } = memorySubjectKeys({ createKeys: 'explicit' });
    expect((await rejection(subjects.encrypt(1, 'x'))).code).toBe('invalid');
    expect(await subjects.create(1)).toEqual({ key: 'subject_1', created: true });
    expect(await subjects.create(1)).toEqual({ key: 'subject_1', created: false });
    expect(await subjects.decrypt(await subjects.encrypt(1, 'x'), { anySubject: true })).toBe('x');
  });

  it('rotateDataKey starts a new data key; old values still open and needsReencrypt sees them', async () => {
    const { subjects } = setup();
    const old = await subjects.encrypt(1, 'old');
    expect(await subjects.needsReencrypt(old, 1)).toBe(false);
    await subjects.rotateDataKey(1);
    const fresh = await subjects.encrypt(1, 'new');
    expect(readSubjectCiphertext(fresh)!.dataKeyId).not.toBe(readSubjectCiphertext(old)!.dataKeyId);
    expect(await subjects.decrypt(old, { anySubject: true })).toBe('old');
    expect(await subjects.needsReencrypt(old, 1)).toBe(true);
    expect(await subjects.needsReencrypt(fresh, 1)).toBe(false);
    expect(await subjects.needsReencrypt(fresh, 2)).toBe(true);
    expect(await subjects.needsReencrypt('plain', 1)).toBe(true);
  });

  it('rewrapDataKeys moves wrapped keys to the latest subject-key version, data untouched', async () => {
    const { subjects, store, crypto } = setup();
    const sealed = await subjects.encrypt(1, 'kept');
    await subjects.encrypt(2, 'other');
    await subjects.forget(2);
    await crypto.service.rotateKey(crypto.principal, 'subject_1');
    const batches: unknown[] = [];
    const result = await subjects.rewrapDataKeys({
      batchSize: 1,
      onBatch: (p) => void batches.push(p),
    });
    expect(result).toMatchObject({ scanned: 1, rewrapped: 1, forgotten: 0 });
    const { dataKeyId } = readSubjectCiphertext(sealed)!;
    expect((await store.get(dataKeyId))!.wrapped.startsWith('agora:ct1:subject_1:2:')).toBe(true);
    // Retire v1: the data still opens through the rewrapped data key.
    await crypto.service.updateKeyPolicy(crypto.principal, 'subject_1', {
      minDecryptionVersion: 2,
    });
    subjects.clear();
    expect(await subjects.decrypt(sealed, { anySubject: true })).toBe('kept');
    // Idempotent.
    expect(await subjects.rewrapDataKeys()).toMatchObject({ scanned: 1, rewrapped: 0 });
    expect(batches.length).toBeGreaterThan(0);
  });

  it('warm loads the current data key so writes need no call', async () => {
    const { subjects, remote } = setup();
    const { key, dataKeyId } = await subjects.warm(11);
    expect(key).toBe('subject_11');
    remote.setDown(true);
    const sealed = await subjects.encrypt(11, 'offline');
    expect(readSubjectCiphertext(sealed)!.dataKeyId).toBe(dataKeyId);
    expect(await subjects.decrypt(sealed, { anySubject: true })).toBe('offline');
  });

  it('decrypt needs the expected subject unless anySubject is explicit', async () => {
    const { subjects } = setup();
    const sealed = await subjects.encrypt(1, 'x');
    expect((await rejection(subjects.decrypt(sealed))).message).toMatch(/expected `subject`/);
    expect(await subjects.decrypt(sealed, { subject: 1 })).toBe('x');
    expect(await subjects.decrypt(sealed, { anySubject: true })).toBe('x');
  });

  it('decryptJson never puts the plaintext in its error', async () => {
    const { subjects } = setup();
    const sealed = await subjects.encrypt(1, 'my secret diagnosis {');
    const error = await rejection(subjects.decryptJson(sealed, { subject: 1 }));
    expect(error.code).toBe('invalid');
    expect(error.message).not.toContain('diagnosis');
    expect(String(error.cause ?? '')).not.toContain('diagnosis');
  });

  it('typed subjects get their own keys; requireType refuses bare ids', async () => {
    const { subjects } = setup();
    expect(subjects.keyName({ type: 'researcher', id: 7 })).toBe('subject_researcher_7');
    expect(subjects.keyName({ type: 'project', id: 7 })).not.toBe(
      subjects.keyName({ type: 'researcher', id: 7 }),
    );
    expect(() => subjects.keyName({ type: 'has_underscore', id: 1 })).toThrow(SubjectKeyError);
    const strict = memorySubjectKeys({ requireType: true }).subjects;
    expect(() => strict.keyName(7)).toThrow(/requireType/);
    const sealed = await strict.encrypt({ type: 'researcher', id: 7 }, 'x');
    expect(await strict.decrypt(sealed, { subject: { type: 'researcher', id: 7 } })).toBe('x');
    expect(
      (await rejection(strict.decrypt(sealed, { subject: { type: 'project', id: 7 } }))).code,
    ).toBe('invalid');
  });

  it('a forget that races a first write never leaves the data key cached', async () => {
    const crypto = memoryCrypto();
    const operations = localOperations(crypto.service, crypto.principal);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const store = new MemoryDataKeyStore();
    const subjects = new SubjectKeys({
      operations: {
        ...operations,
        generateDataKey: async (input) => {
          const result = await operations.generateDataKey(input);
          if (!gated) {
            gated = true;
            await gate;
          }
          return result;
        },
      },
      store,
    });
    await subjects.create(1);
    const write = subjects.encrypt(1, 'in flight');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await subjects.forget(1);
    release();
    expect((await rejection(write)).code).toBe('forgotten');
    expect(subjects.cache.size).toBe(0);
    expect(await store.page({ limit: 10 })).toEqual([]);
    expect((await rejection(subjects.encrypt(1, 'after'))).code).toBe('forgotten');
  });

  it('a rotation that races a provision does not bring the retired data key back as current', async () => {
    const crypto = memoryCrypto();
    const operations = localOperations(crypto.service, crypto.principal);
    const store = new MemoryDataKeyStore();
    let gate: Promise<void> | undefined;
    let release!: () => void;
    const subjects = new SubjectKeys({
      operations: {
        ...operations,
        decrypt: async (input) => {
          const result = await operations.decrypt(input);
          if (gate) await gate;
          return result;
        },
      },
      store,
    });
    const first = readSubjectCiphertext(await subjects.encrypt(1, 'a'))!;
    subjects.clear();
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = subjects.encrypt(1, 'b');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const rotated = subjects.rotateDataKey(1);
    gate = undefined;
    release();
    await rotated;
    const second = readSubjectCiphertext(await write)!;
    expect(second.dataKeyId).not.toBe(first.dataKeyId);
    expect(subjects.cache.current('subject_1')?.id).not.toBe(first.dataKeyId);
    const third = readSubjectCiphertext(await subjects.encrypt(1, 'c'))!;
    expect(third.dataKeyId).toBe(second.dataKeyId);
  });

  it('two processes sharing a store: both read each other; a forget elsewhere is final once evicted', async () => {
    const crypto = memoryCrypto();
    const store = new MemoryDataKeyStore();
    const make = () =>
      new SubjectKeys({ operations: localOperations(crypto.service, crypto.principal), store });
    const a = make();
    const b = make();
    const [fromA, fromB] = await Promise.all([a.encrypt(1, 'from a'), b.encrypt(1, 'from b')]);
    expect(await a.decrypt(fromB, { subject: 1 })).toBe('from b');
    expect(await b.decrypt(fromA, { subject: 1 })).toBe('from a');
    await a.forget(1);
    // b still holds the data key until its TTL, or until it is told to evict.
    expect(await b.decrypt(fromA, { subject: 1 })).toBe('from a');
    b.evict(1);
    expect((await rejection(b.decrypt(fromA, { subject: 1 }))).code).toBe('forgotten');
    expect((await rejection(b.encrypt(1, 'new'))).code).toBe('forgotten');
  });

  it('works with a token scoped to subject keys only (key-name prefix capabilities)', async () => {
    const crypto = memoryCrypto({
      capabilities: [
        'crypto:datakey:subject_*',
        'crypto:encrypt:subject_*',
        'crypto:decrypt:subject_*',
        'crypto:rewrap:subject_*',
        'crypto:keys:read:subject_*',
        'crypto:keys:manage:subject_*',
      ],
    });
    const admin = { ...crypto.principal, capabilities: ['crypto:*'] };
    await crypto.service.createKey(admin, {
      name: 'orders',
      type: 'aes256-gcm',
      deletionAllowed: true,
    });
    const subjects = new SubjectKeys({
      operations: localOperations(crypto.service, crypto.principal),
      store: new MemoryDataKeyStore(),
    });
    const sealed = await subjects.encrypt(1, 'x');
    expect(await subjects.decrypt(sealed, { subject: 1 })).toBe('x');
    await crypto.service.rotateKey(admin, 'subject_1');
    expect(await subjects.rewrapDataKeys()).toMatchObject({ rewrapped: 1 });
    await subjects.forget(1);
    await expect(
      crypto.service.encrypt(crypto.principal, { key: 'orders', plaintext: 'x' }),
    ).rejects.toThrow(/lacks/);
    await expect(crypto.service.deleteKey(crypto.principal, 'orders')).rejects.toThrow(/lacks/);
  });

  it('JSON helpers round-trip', async () => {
    const { subjects } = setup();
    const value = { a: [1, 2], b: 'ç', c: null };
    expect(
      await subjects.decryptJson(await subjects.encryptJson(1, value), { anySubject: true }),
    ).toEqual(value);
  });

  it('maps control-plane refusals to typed errors', async () => {
    const crypto = memoryCrypto({ capabilities: ['crypto:keys:read'] });
    const subjects = new SubjectKeys({
      operations: localOperations(crypto.service, crypto.principal),
      store: new MemoryDataKeyStore(),
    });
    expect((await rejection(subjects.encrypt(1, 'x'))).code).toBe('denied');
  });

  it('zeroes the cache on clear', async () => {
    const { subjects } = setup();
    const sealed = await subjects.encrypt(1, 'x');
    const entry = subjects.cache.get(readSubjectCiphertext(sealed)!.dataKeyId)!;
    const spy = vi.spyOn(entry.bytes, 'fill');
    subjects.clear();
    expect(spy).toHaveBeenCalledWith(0);
    expect(entry.bytes.every((byte) => byte === 0)).toBe(true);
  });
});
