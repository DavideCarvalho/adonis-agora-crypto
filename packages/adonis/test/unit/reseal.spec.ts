import { describe, expect, it } from 'vitest';
import { createCryptoKeyring } from '../../src/crypto/keyring.js';
import { materialStatus, resealKeyMaterial } from '../../src/crypto/reseal.js';
import { type CryptoPrincipal, CryptoService } from '../../src/crypto/service.js';
import { MemoryStore } from '../../src/store/memory_store.js';

const principal: CryptoPrincipal = {
  partition: 'shop',
  capabilities: ['crypto:*'],
  actor: 'test',
};

/** One store, two roots: the old one alone, then `[new, old]` (a rotation nobody re-sealed yet). */
async function scenario() {
  const store = new MemoryStore();
  const oldRoot = 'the-old-root-key-of-32-characters!!';
  const newRoot = 'the-new-root-key-of-32-characters!!';
  const before = new CryptoService({ store, keyring: createCryptoKeyring({ appKey: oldRoot }) });
  await before.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
  await before.createKey(principal, { name: 'inbox', type: 'x25519' });
  const encrypted = await before.encrypt(principal, { key: 'orders', plaintext: 'still readable' });
  const rotated = new CryptoService({
    store,
    keyring: createCryptoKeyring({ keys: [newRoot, oldRoot] }),
  });
  return { store, oldRoot, newRoot, encrypted, rotated };
}

describe('key material reseal', () => {
  it('marks versions sealed with a retired root and rewrites them, without touching ciphertext', async () => {
    const { store, newRoot, oldRoot, encrypted, rotated } = await scenario();
    const statuses = await materialStatus(store, rotated.keyring);
    expect(statuses).toEqual({ active: 0, retired: 2, legacy: 0, unreadable: 0 });

    const report = await resealKeyMaterial(store, rotated.keyring);
    expect(report).toMatchObject({ scanned: 2, resealed: 2, failed: 0, dryRun: false });
    expect(await materialStatus(store, rotated.keyring)).toMatchObject({ active: 2, retired: 0 });

    // The old ciphertext still opens: the key itself never changed, only its envelope.
    expect(
      await rotated.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext }),
    ).toMatchObject({ plaintext: 'still readable' });

    // Only the new root is needed now.
    const onlyNew = new CryptoService({ store, keyring: createCryptoKeyring({ keys: [newRoot] }) });
    expect(
      await onlyNew.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext }),
    ).toMatchObject({ plaintext: 'still readable' });
    // And the old root alone can no longer open the re-sealed material.
    const onlyOld = new CryptoService({ store, keyring: createCryptoKeyring({ keys: [oldRoot] }) });
    await expect(onlyOld.getKey(principal, 'orders')).resolves.toBeDefined();
    await expect(
      onlyOld.encrypt(principal, { key: 'orders', plaintext: 'x' }),
    ).rejects.toMatchObject({ code: 'unreadable' });
  });

  it('is a no-op when every version is already on the active root, unless --all', async () => {
    const { store, rotated } = await scenario();
    await resealKeyMaterial(store, rotated.keyring);
    expect(await resealKeyMaterial(store, rotated.keyring)).toMatchObject({
      scanned: 2,
      resealed: 0,
    });
    expect(await resealKeyMaterial(store, rotated.keyring, { all: true })).toMatchObject({
      resealed: 2,
    });
  });

  it('a dry run counts without writing, and a lost root is a failure', async () => {
    const { store, rotated } = await scenario();
    const dry = await resealKeyMaterial(store, rotated.keyring, { dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, resealed: 2 });
    expect(await materialStatus(store, rotated.keyring)).toMatchObject({ retired: 2 });

    const lost = new CryptoService({
      store,
      keyring: createCryptoKeyring({ appKey: 'a-root-nobody-has-of-32-characters' }),
    });
    const report = await resealKeyMaterial(store, lost.keyring);
    expect(report).toMatchObject({ failed: 2, resealed: 0 });
    expect(report.statuses.unreadable).toBe(2);
    expect((await materialStatus(store, lost.keyring)).unreadable).toBe(2);
  });
});
