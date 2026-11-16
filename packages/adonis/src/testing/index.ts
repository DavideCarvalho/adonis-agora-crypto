/**
 * Test helpers for apps and for this package: a memory store and a service whose key material is
 * sealed with a fixed test key, plus the principal a test acts as.
 */

import { type CryptoKeyringConfig, createCryptoKeyring } from '../crypto/keyring.js';
import { type CryptoPrincipal, CryptoService } from '../crypto/service.js';
import { localOperations } from '../operations.js';
import { MemoryStore } from '../store/memory_store.js';
import type { DataKeyCacheOptions } from '../subjects/cache.js';
import { MemoryDataKeyStore } from '../subjects/store.js';
import { SubjectKeys } from '../subjects/subject_keys.js';

export { LucidStore } from '../store/lucid_store.js';
export { MemoryStore } from '../store/memory_store.js';
export { MemoryDataKeyStore } from '../subjects/store.js';

/** A keyring with one readable app key (the kit needs 16+ characters). */
export function testKeyring(
  options: CryptoKeyringConfig & { appKey?: string } = {},
): ReturnType<typeof createCryptoKeyring> {
  return createCryptoKeyring({
    appKey: options.appKey ?? 'test-key-for-agora-crypto-key-material',
    ...options,
  });
}

export interface MemoryCryptoOptions {
  partition?: string;
  capabilities?: string[];
  actor?: string;
  appKey?: string;
  now?: () => string;
}

export interface MemoryCrypto {
  store: MemoryStore;
  service: CryptoService;
  principal: CryptoPrincipal;
}

/**
 * A crypto server in memory: `{ store, service, principal }`. The principal holds `crypto:*` on
 * the `shop` partition by default; pass `capabilities` to test a narrower token.
 */
export function memoryCrypto(options: MemoryCryptoOptions = {}): MemoryCrypto {
  const store = new MemoryStore(options.now ? { now: options.now } : {});
  const service = new CryptoService({
    store,
    keyring: testKeyring({ appKey: options.appKey ?? 'test-key-for-agora-crypto-key-material' }),
    ...(options.now ? { now: options.now } : {}),
  });
  const partition = options.partition ?? 'shop';
  return {
    store,
    service,
    principal: {
      partition,
      capabilities: options.capabilities ?? ['crypto:*'],
      actor: options.actor ?? 'test',
    },
  };
}

/** Creates one key of each type a test needs, on a partition. */
export async function seedKeys(
  crypto: MemoryCrypto,
  partition = crypto.principal.partition,
): Promise<void> {
  const principal: CryptoPrincipal = {
    partition,
    capabilities: ['crypto:*'],
    actor: 'test',
  };
  await crypto.service.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
  await crypto.service.createKey(principal, { name: 'root', type: 'aes256-gcm' });
  await crypto.service.createKey(principal, { name: 'inbox', type: 'x25519' });
  await crypto.service.createKey(principal, { name: 'webhook', type: 'ed25519' });
  await crypto.service.createKey(principal, { name: 'session', type: 'hmac-sha256' });
}

export interface MemorySubjectKeysOptions extends MemoryCryptoOptions {
  /** Cache options, or `false`. Default: the production defaults. */
  cache?: DataKeyCacheOptions | false;
  prefix?: string;
  createKeys?: 'lazy' | 'explicit';
}

/**
 * Subject keys over an in-memory crypto server and an in-memory data-key store: `{ subjects,
 * crypto, store }`. The server side (`crypto.service`) is there to inspect or break things.
 */
export function memorySubjectKeys(options: MemorySubjectKeysOptions = {}): {
  subjects: SubjectKeys;
  crypto: MemoryCrypto;
  store: MemoryDataKeyStore;
} {
  const crypto = memoryCrypto(options);
  const store = new MemoryDataKeyStore();
  const subjects = new SubjectKeys({
    operations: localOperations(crypto.service, crypto.principal),
    store,
    ...(options.cache !== undefined ? { cache: options.cache } : {}),
    ...(options.prefix !== undefined ? { prefix: options.prefix } : {}),
    ...(options.createKeys !== undefined ? { createKeys: options.createKeys } : {}),
  });
  return { subjects, crypto, store };
}
