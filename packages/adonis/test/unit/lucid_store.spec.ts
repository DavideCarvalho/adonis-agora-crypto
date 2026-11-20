import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { type CryptoStore } from '../../src/store/store.js';
import { testKeyring } from '../../src/testing/index.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function sqlite(): Promise<SqlDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'agora-crypto-test-'));
  const app = new AppFactory().create(new URL('./', import.meta.url), () => {});
  await app.init();
  const database = new Database(
    {
      connection: 'sqlite',
      connections: {
        sqlite: {
          client: 'better-sqlite3',
          connection: { filename: join(dir, 'db.sqlite') },
          useNullAsDefault: true,
        },
      },
    },
    new LoggerFactory().create(),
    new Emitter(app),
  );
  closers.push(async () => {
    await database.manager.closeAll();
    rmSync(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

async function service(): Promise<CryptoService> {
  const store = new LucidStore(await sqlite());
  await store.setup();
  return new CryptoService({ store, keyring: testKeyring() });
}

const principal = {
  partition: 'shop',
  capabilities: ['crypto:*'],
  actor: 'test',
};

describe('LucidStore', () => {
  it('runs the key lifecycle and keeps only sealed material in the database', async () => {
    const crypto = await service();
    const created = await crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    expect(created.versions[0]?.status).toBe('latest');

    const encrypted = await crypto.encrypt(principal, { key: 'orders', plaintext: 'db secret' });
    expect(
      await crypto.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext }),
    ).toMatchObject({ plaintext: 'db secret' });

    // Nothing in the version row is plaintext key material or plaintext data.
    const store = crypto.store as LucidStore;
    const rows = await store.versions('shop', 'orders');
    expect(rows[0]?.sealed.startsWith('agora:v1:')).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('db secret');

    const rotated = await crypto.rotateKey(principal, 'orders');
    expect(rotated.latestVersion).toBe(2);
    const rewrapped = await crypto.rewrap(principal, {
      key: 'orders',
      ciphertext: encrypted.ciphertext,
    });
    expect(rewrapped.version).toBe(2);
    expect(
      await crypto.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext }),
    ).toMatchObject({ plaintext: 'db secret', version: 1 });
  });

  it('keeps asymmetric keys and their kid, and serves the JWKS', async () => {
    const crypto = await service();
    const created = await crypto.createKey(principal, { name: 'inbox', type: 'x25519' });
    const kid = created.versions[0]?.kid;
    expect(kid).toBeTypeOf('string');
    const encrypted = await crypto.encrypt(principal, { key: 'inbox', plaintext: 'hello' });
    expect(encrypted.ciphertext.startsWith('agora:pk1:')).toBe(true);
    expect(
      await crypto.decrypt(principal, { key: 'inbox', ciphertext: encrypted.ciphertext }),
    ).toMatchObject({ plaintext: 'hello' });
    await crypto.rotateKey(principal, 'inbox');
    expect((await crypto.jwks(principal, 'inbox')).keys).toHaveLength(2);
  });

  it('lists, pages and filters the audit trail, and counts the last 24h', async () => {
    const crypto = await service();
    await crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    const encrypted = await crypto.encrypt(principal, { key: 'orders', plaintext: 'x' });
    await crypto.decrypt(principal, { key: 'orders', ciphertext: encrypted.ciphertext });
    const denied = { partition: 'shop', capabilities: ['crypto:keys:read'], actor: 'svc' };
    await expect(crypto.encrypt(denied, { key: 'orders', plaintext: 'x' })).rejects.toMatchObject({
      code: 'forbidden',
    });

    const all = await crypto.audit(principal, { page: 1, size: 10 });
    expect(all.meta.total).toBeGreaterThanOrEqual(4);
    expect(all.data[0]?.at >= all.data[all.data.length - 1]!.at).toBe(true);

    const asc = await crypto.audit(principal, { page: 1, size: 10, sort: 'asc' });
    expect(asc.data.map((row) => row.operation)).toContain('create');
    expect(asc.data[0]!.at <= asc.data[asc.data.length - 1]!.at).toBe(true);

    const deniedOnly = await crypto.audit(principal, {
      page: 1,
      size: 10,
      filters: { result: 'denied', actor: 'svc' },
    });
    expect(deniedOnly.data).toHaveLength(1);

    const paged = await crypto.audit(principal, { page: 2, size: 2 });
    expect(paged.meta).toMatchObject({ currentPage: 2, perPage: 2 });
    expect(paged.data).toHaveLength(2);

    const overview = await crypto.overview(principal);
    expect(overview.keys).toBe(1);
    expect(overview.operations24h).toBeGreaterThanOrEqual(2);
  });

  it('refuses a duplicate key, persists the policy and destroys material on delete', async () => {
    const crypto = await service();
    await crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    await expect(
      crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' }),
    ).rejects.toThrow();
    await crypto.updateKeyPolicy(principal, 'orders', {
      description: 'pii',
      minDecryptionVersion: 1,
      deletionAllowed: true,
    });
    expect(await crypto.getKey(principal, 'orders')).toMatchObject({ description: 'pii' });
    await crypto.deleteKey(principal, 'orders');
    await expect(crypto.getKey(principal, 'orders')).resolves.toMatchObject({
      minDecryptionVersion: 2,
    });
    expect(await (crypto.store as LucidStore).versions('shop', 'orders')).toHaveLength(0);
  });

  it('isolates partitions and treats partitions() as the console’s app list', async () => {
    const crypto = await service();
    await crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    await crypto.createKey(
      { ...principal, partition: 'billing' },
      { name: 'invoices', type: 'aes256-gcm' },
    );
    expect(await (crypto.store as LucidStore).partitions()).toEqual(['billing', 'shop']);
    expect((await crypto.listKeys(principal, { page: 1, size: 10 })).meta.total).toBe(1);
  });
});

describe.each([
  ['LucidStore', async (): Promise<CryptoStore> => new LucidStore(await sqlite())],
  ['MemoryStore', async (): Promise<CryptoStore> => new MemoryStore()],
])('%s timestamps', (_name, make) => {
  it('sets createdAt and updatedAt on create; updates move updatedAt only', async () => {
    const store = await make();
    await store.setup?.();
    let clock = '2026-01-01T00:00:00.000Z';
    const crypto = new CryptoService({ store, keyring: testKeyring(), now: () => clock });

    const created = await crypto.createKey(principal, { name: 'orders', type: 'aes256-gcm' });
    expect(created.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(created.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(created.updatedBy).toBe('test');

    clock = '2026-02-01T00:00:00.000Z';
    const rotated = await crypto.rotateKey(principal, 'orders');
    expect(rotated.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rotated.updatedAt).toBe('2026-02-01T00:00:00.000Z');
    // Versions are append-only: each keeps its own createdAt and has no updatedAt.
    expect(rotated.versions.map((version) => version.createdAt)).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-02-01T00:00:00.000Z',
    ]);
    expect(rotated.versions[0]).not.toHaveProperty('updatedAt');

    clock = '2026-03-01T00:00:00.000Z';
    const changed = await crypto.updateKeyPolicy(principal, 'orders', { exportable: true });
    expect(changed.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(changed.updatedAt).toBe('2026-03-01T00:00:00.000Z');

    const listed = await store.getKey('shop', 'orders');
    expect(listed).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
  });
});
