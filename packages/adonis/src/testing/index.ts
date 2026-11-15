/**
 * Test helpers for apps and for this package: a memory store and a service whose key material is
 * sealed with a fixed test key, plus the principal a test acts as.
 */

import { type CryptoKeyringConfig, createCryptoKeyring } from '../crypto/keyring.js';
import { type CryptoPrincipal, CryptoService } from '../crypto/service.js';
import { MemoryStore } from '../store/memory_store.js';

export { LucidStore } from '../store/lucid_store.js';
export { MemoryStore } from '../store/memory_store.js';

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
