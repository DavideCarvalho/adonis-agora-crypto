import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Emitter } from '@adonisjs/core/events';
import { AppFactory } from '@adonisjs/core/factories/app';
import { LoggerFactory } from '@adonisjs/core/factories/logger';
import { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { CryptoConsole } from '../../src/dashboard/console.js';
import { resolveDashboardConfig } from '../../src/dashboard/define_config.js';
import {
  commandKeyOpener,
  cryptoConsoleCommandHandler,
  ensureConsoleCommandKey,
  FederatedCryptoApps,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { query, type SqlDatabase } from '../../src/sql.js';
import { LucidStore } from '../../src/store/lucid_store.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testKeyring } from '../../src/testing/index.js';
import { addressOf, type Handler, serve } from '../http_harness.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * Two apps sharing a database and a Redis: "Entre Textos" runs crypto standalone (its own store,
 * its own root key, its own audit), the Hub's console shows it through `federatedApps`. The Hub
 * reads key metadata and the audit from Entre Textos' tables; every key operation, Entre Textos
 * runs and audits itself.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

const ET = 'entre-textos';
const PREFIX = 'entretextos';
/** The Hub's token for Entre Textos, as Entre Textos' `verifyTenant` (authkit's, in real life) sees it. */
const HUB_TOKEN = 'hub-token-for-entre-textos';
const verifyTenant = ({ token }: { token?: string | undefined }) =>
  token === HUB_TOKEN ? { partition: ET, capabilities: ['crypto:*'], clientId: 'hub' } : null;

async function sqlite(): Promise<SqlDatabase> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-crypto-fed-'));
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
    await rm(dir, { recursive: true, force: true });
  });
  return database.connection() as unknown as SqlDatabase;
}

async function spaDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-crypto-fed-spa-'));
  closers.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'index.html'), '<html><head></head><body></body></html>');
  return dir;
}

function router(routes: Array<{ method: string; pattern: string; handler: Handler }>) {
  const add = (method: string) => (pattern: string, handler: Handler) => {
    routes.push({ method, pattern, handler });
  };
  return { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE') };
}

interface Setup {
  owner?: { actions?: boolean; capabilities?: string[]; instances?: number; listening?: boolean };
  grant?: { apps?: string[]; capabilities?: string[] };
  entry?: { actions?: boolean };
}

async function setup(options: Setup = {}) {
  const db = await sqlite();
  const bus = new RedisBus();

  // Entre Textos: standalone, its own root key and store.
  const etStore = new LucidStore(db);
  await etStore.setup();
  const et = new CryptoService({
    store: etStore,
    keyring: testKeyring({ appKey: 'et-root-key-0123456789abcdef' }),
  });
  const seed = { partition: ET, capabilities: ['crypto:*'], actor: 'deploy' };
  await et.createKey(seed, { name: 'thesis', type: 'aes256-gcm', deletionAllowed: true });
  await et.createKey(seed, { name: 'webhooks', type: 'hmac-sha256' });
  await et.createKey(seed, { name: 'signing', type: 'ed25519' });
  const runs: string[] = [];
  const owner = options.owner ?? {};
  // Token mode: Entre Textos publishes its command key in its own tables, where the Hub reads it.
  await ensureConsoleCommandKey(et, ET);
  if (owner.listening !== false) {
    for (let i = 0; i < (owner.instances ?? 2); i++) {
      const channel = new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        verifyTenant,
        opener: commandKeyOpener(et, [ET]),
      });
      const handler = cryptoConsoleCommandHandler({
        service: et,
        actions: owner.actions ?? true,
        ...(owner.capabilities ? { capabilities: owner.capabilities } : {}),
        partitions: [ET],
      });
      await channel.answer(async (command) => {
        runs.push(`${i}:${command.verb}`);
        return handler(command);
      });
      closers.push(() => channel.close());
    }
  }

  // The Hub: its own keys, and Entre Textos federated.
  const hub = new CryptoService({ store: new MemoryStore(), keyring: testKeyring() });
  await hub.createKey(
    { partition: 'eduliberta', capabilities: ['crypto:*'], actor: 'hub' },
    { name: 'courses', type: 'aes256-gcm' },
  );
  const federated = new FederatedCryptoApps(
    {
      et: {
        label: 'Entre Textos',
        partition: ET,
        store: { connection: 'et' },
        controlPlane: { prefix: PREFIX, token: HUB_TOKEN },
        timeoutMs: 500,
        ...(options.entry ?? {}),
      },
    },
    { db: async () => db, redis: async () => bus.connection() },
  );
  closers.push(() => federated.close());
  const grant = options.grant ?? {};
  const config = resolveDashboardConfig({
    appLabel: 'Hub',
    authorize: (ctx) => {
      const viewer = ctx.request.header('x-viewer');
      if (!viewer) return { allowed: false, reason: 'unauthenticated' };
      (ctx as unknown as { auth: unknown }).auth = { user: { id: viewer } };
      return { allowed: true, ...grant };
    },
  });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  new CryptoConsole({
    service: hub,
    config,
    spaDir: await spaDir(),
    inProduction: true,
    topology: 'control-plane',
    logger: { info: () => {}, warn: () => {} },
    federated,
  }).register(router(routes));
  const server: Server = await serve(routes);
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `${addressOf(server)}/_crypto/api`;
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'x-viewer': 'ana@hub', 'content-type': 'application/json' },
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const etAudit = async (filters: Record<string, string> = {}) =>
    (await et.audit(seed, { page: 1, size: 50, filters })).data;
  return { db, bus, et, etStore, call, runs, etAudit };
}

describe('federated crypto console', () => {
  it('lists the federated app next to the local partitions, with its mode', async () => {
    const { call } = await setup();
    const apps = await call('/apps');
    expect(apps.body).toEqual({
      local: { label: 'Hub' },
      apps: [{ id: 'et', label: 'Entre Textos', mode: 'federated', actions: 'app' }],
      selected: null,
    });
    const meta = await call('/meta');
    expect(meta.body.apps).toEqual(['eduliberta', 'et']);
    expect(meta.body.federated).toEqual(apps.body.apps);
  });

  it('reads key metadata, versions and the audit from its tables, never the material', async () => {
    const { call, bus, runs, db, etAudit } = await setup();
    const before = (await etAudit()).length;
    const keys = await call('/keys?partition=et');
    expect(keys.status).toBe(200);
    // The app's own keys, and the command key the Hub seals its commands to (token mode).
    expect(keys.body.data.map((k: any) => k.name)).toEqual([
      'console-commands',
      'signing',
      'thesis',
      'webhooks',
    ]);
    const one = await call('/keys/signing?partition=et');
    expect(one.body).toMatchObject({ name: 'signing', type: 'ed25519', latestVersion: 1 });
    expect(one.body.versions[0].publicKey).toMatchObject({ kty: 'OKP' });
    const overview = await call('/overview?partition=et');
    expect(overview.body).toMatchObject({ partition: ET, keys: 4, versions: 4 });
    const audit = await call('/audit?partition=et');
    expect(audit.body.data.length).toBe(before);

    // Nothing the console sent contains a sealed material string.
    const material = await query<{ material: string }>(
      db,
      'SELECT material FROM crypto_key_versions',
    );
    const everything = JSON.stringify([keys.body, one.body, overview.body, audit.body]);
    for (const row of material) expect(everything).not.toContain(row.material);
    // Reads never asked the app anything, and wrote nothing in its audit.
    expect(runs).toEqual([]);
    expect(bus.published).toEqual([]);
    expect((await etAudit()).length).toBe(before);
  });

  it('a metadata-only store never selects the material and cannot write', async () => {
    const { db } = await setup();
    const reader = new LucidStore(db, { metadataOnly: true });
    const versions = await reader.versions(ET, 'thesis');
    expect(versions[0]).toMatchObject({ version: 1, sealed: '' });
    await expect(reader.deleteKey(ET, 'thesis', 'now', 'x')).rejects.toThrow(/only reads/);
  });

  it('runs key operations in the app, audited there with the Hub viewer', async () => {
    const { call, runs, etAudit, bus } = await setup();
    const rotated = await call('/keys/thesis/rotate?partition=et', { method: 'POST', body: '{}' });
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ name: 'thesis', latestVersion: 2 });
    expect(runs.filter((r) => r.endsWith(':rotateKey'))).toHaveLength(1);
    expect((await etAudit({ operation: 'rotate' }))[0]).toMatchObject({
      actor: 'ana@hub',
      clientId: 'console:Hub',
      result: 'ok',
    });

    const policy = await call('/keys/thesis?partition=et', {
      method: 'PATCH',
      body: JSON.stringify({ minDecryptionVersion: 2, description: 'thesis bodies' }),
    });
    expect(policy.body).toMatchObject({ minDecryptionVersion: 2, description: 'thesis bodies' });

    for (const name of ['thesis', 'webhooks', 'signing']) {
      const test = await call(`/keys/${name}/test?partition=et`, { method: 'POST', body: '{}' });
      expect(test.status).toBe(200);
      expect(test.body).toMatchObject({ key: name, ok: true });
      expect(Object.keys(test.body).sort()).toEqual(['key', 'ok', 'operations', 'type', 'version']);
    }
    expect((await etAudit({ operation: 'decrypt', key: 'thesis' }))[0]).toMatchObject({
      actor: 'ana@hub',
    });

    const created = await call('/keys?partition=et', {
      method: 'POST',
      body: JSON.stringify({ name: 'drafts', type: 'x25519' }),
    });
    expect(created.status).toBe(201);
    const deleted = await call('/keys/thesis?partition=et', { method: 'DELETE' });
    expect(deleted.body).toEqual({ key: 'thesis', deleted: true });
    // No key material ever crossed the bus, nor the Hub's token, nor what it asked for.
    expect(bus.wire).not.toMatch(/agora:v1:/);
    expect(bus.wire).not.toContain(HUB_TOKEN);
    const commands = bus.published
      .filter((p) => p.channel === `${PREFIX}-crypto-console`)
      .map((p) => p.message)
      .join('\n');
    expect(commands).not.toContain('ana@hub');
    expect(commands).not.toContain('rotateKey');
  });

  it('rewraps through the app and returns only the new ciphertext', async () => {
    const { call, et } = await setup();
    const sealed = await et.encrypt(
      { partition: ET, capabilities: ['crypto:*'], actor: 'app' },
      { key: 'thesis', plaintext: 'chapter one' },
    );
    await call('/keys/thesis/rotate?partition=et', { method: 'POST', body: '{}' });
    const rewrapped = await call('/keys/thesis/rewrap?partition=et', {
      method: 'POST',
      body: JSON.stringify({ ciphertext: sealed.ciphertext }),
    });
    expect(rewrapped.status).toBe(200);
    expect(rewrapped.body).toMatchObject({ key: 'thesis', version: 2 });
    expect(JSON.stringify(rewrapped.body)).not.toContain('chapter one');
  });

  it("narrows to the viewer's capabilities and audits the denial in the app", async () => {
    const { call, etAudit } = await setup({ grant: { capabilities: ['crypto:keys:read'] } });
    const refused = await call('/keys/thesis/rotate?partition=et', { method: 'POST', body: '{}' });
    expect(refused.status).toBe(403);
    expect((await etAudit({ result: 'denied' }))[0]).toMatchObject({
      actor: 'ana@hub',
      operation: 'rotate',
    });
  });

  it('never exports, and honors what the app allows', async () => {
    const narrow = await setup({
      owner: { capabilities: ['crypto:keys:read', 'crypto:keys:export'] },
    });
    const rotate = await narrow.call('/keys/thesis/rotate?partition=et', {
      method: 'POST',
      body: '{}',
    });
    expect(rotate.status).toBe(403);
    const off = await setup({ owner: { actions: false } });
    const refused = await off.call('/keys/thesis/rotate?partition=et', {
      method: 'POST',
      body: '{}',
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/consoleCommands.actions/);

    const hubOff = await setup({ entry: { actions: false } });
    expect((await hubOff.call('/apps')).body.apps[0].actions).toBe('none');
    expect(
      (await hubOff.call('/keys/thesis/rotate?partition=et', { method: 'POST', body: '{}' }))
        .status,
    ).toBe(403);
    expect(hubOff.runs).toEqual([]);
  });

  it('answers 503 at once when no instance listens, and hides apps outside the grant', async () => {
    const silent = await setup({ owner: { listening: false } });
    const rotate = await silent.call('/keys/thesis/rotate?partition=et', {
      method: 'POST',
      body: '{}',
    });
    expect(rotate.status).toBe(503);
    expect((await silent.call('/keys?partition=et')).status).toBe(200);

    const narrow = await setup({ grant: { apps: ['eduliberta'] } });
    expect((await narrow.call('/apps')).body.apps).toEqual([]);
    expect((await narrow.call('/meta')).body.apps).toEqual(['eduliberta']);
    expect((await narrow.call('/keys?partition=et')).status).toBe(403);
  });
});
