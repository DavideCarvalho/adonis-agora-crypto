import type { Server } from 'node:http';
import { createCryptoClient } from '@adonis-agora/crypto-client';
import { afterEach, describe, expect, it } from 'vitest';
import { createKeyring, open, seal, sealedStatus } from '../../adonis/src/crypto-kit/index.js';
import { CryptoApi } from '../../adonis/src/http/api.js';
import { memoryCrypto } from '../../adonis/src/testing/index.js';
import type { VerifiedTenant } from '../../adonis/src/topology/verify.js';
import { addressOf, type Handler, serve } from '../../adonis/test/http_harness.js';
import {
  CONFIG_ROOT_KEY,
  configCrypto,
  configCryptoAad,
  configKms,
  isCryptoReference,
} from '../src/config.js';

const entry = { app: 'streaming', environment: 'production', key: 'db.password' };

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function router(routes: Array<{ method: string; pattern: string; handler: Handler }>) {
  return {
    get(pattern: string, handler: Handler) {
      routes.push({ method: 'GET', pattern, handler });
      return { as: () => {} };
    },
    post(pattern: string, handler: Handler) {
      routes.push({ method: 'POST', pattern, handler });
      return {};
    },
    patch(pattern: string, handler: Handler) {
      routes.push({ method: 'PATCH', pattern, handler });
      return {};
    },
    delete(pattern: string, handler: Handler) {
      routes.push({ method: 'DELETE', pattern, handler });
      return {};
    },
  };
}

/** The config control plane's token (encrypt only) and the app's (decrypt only), same partition. */
const verifier = async (request: { token?: string }): Promise<VerifiedTenant | null> => {
  if (request.token === 'control-plane') {
    return {
      partition: 'platform',
      capabilities: ['crypto:encrypt:config-root', 'crypto:keys:read'],
    };
  }
  if (request.token === 'app') {
    return { partition: 'platform', capabilities: ['crypto:decrypt:config-root'] };
  }
  return null;
};

async function platform() {
  const crypto = memoryCrypto({ partition: 'platform' });
  await crypto.service.createKey(crypto.principal, { name: 'config-root', type: 'aes256-gcm' });
  const api = new CryptoApi({ service: crypto.service, verifyTenant: verifier });
  const routes: Array<{ method: string; pattern: string; handler: Handler }> = [];
  api.register(router(routes));
  const server = await serve(routes);
  servers.push(server);
  const url = `${addressOf(server)}/_crypto`;
  const client = (token: string) =>
    createCryptoClient({ url, partition: 'platform', token, retries: 0 });
  return { crypto, url, client };
}

describe('server-held config secrets (embedded)', () => {
  it('stores only { key, ciphertext }, opens with the same aad, and binds the entry', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: CONFIG_ROOT_KEY, type: 'aes256-gcm' });
    const secrets = configCrypto({ source: { service: crypto.service, partition: 'shop' } });

    const reference = await secrets.seal('hunter2', entry);
    expect(reference).toMatchObject({ key: 'config-root' });
    expect(Object.keys(reference).sort()).toEqual(['ciphertext', 'key']);
    expect(reference.ciphertext.startsWith('agora:ct1:config-root:1:')).toBe(true);
    expect(JSON.stringify(reference)).not.toContain('hunter2');

    expect(await secrets.open(reference, entry)).toBe('hunter2');
    // Another entry's aad does not open it.
    await expect(secrets.open(reference, { ...entry, key: 'db.user' })).rejects.toBeDefined();
    await expect(secrets.open(reference, { ...entry, app: 'billing' })).rejects.toBeDefined();
  });

  it('refuses plaintext smuggled next to the reference, a foreign key, and a non-agora ciphertext', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: CONFIG_ROOT_KEY, type: 'aes256-gcm' });
    const secrets = configCrypto({ source: { service: crypto.service, partition: 'shop' } });
    const reference = await secrets.seal('x', entry);

    expect(isCryptoReference(reference)).toBe(true);
    expect(isCryptoReference({ ...reference, value: 'plaintext' })).toBe(false);
    expect(() => secrets.parseReference({ ...reference, value: 'plaintext' })).toThrow(
      /no plaintext/,
    );
    expect(() =>
      secrets.parseReference({ key: 'fleet-root', ciphertext: reference.ciphertext }),
    ).toThrow(/not configured to open/);
    expect(() => secrets.parseReference({ key: 'config-root', ciphertext: 'nope' })).toThrow(
      /agora:/,
    );
    expect(() => secrets.parseReference('hunter2')).toThrow(/reference is \{ key, ciphertext \}/);
  });

  it('keeps old references opening after a rotation', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: CONFIG_ROOT_KEY, type: 'aes256-gcm' });
    const secrets = configCrypto({ source: { service: crypto.service, partition: 'shop' } });
    const before = await secrets.seal('old', entry);
    await crypto.service.rotateKey(crypto.principal, CONFIG_ROOT_KEY);
    const after = await secrets.seal('new', entry);

    expect(before.ciphertext).not.toBe(after.ciphertext);
    expect(after.ciphertext).toContain('config-root:2:');
    expect(await secrets.open(before, entry)).toBe('old');
    expect(await secrets.open(after, entry)).toBe('new');
    expect(configCryptoAad(entry)).toBe('config:streaming:production:main:db.password');
  });
});

describe('server-held config secrets (remote, split capabilities)', () => {
  it('seals with an encrypt-only token and opens with a decrypt-only one', async () => {
    const { client } = await platform();
    const controlPlane = configCrypto({ source: { client: client('control-plane') } });
    const app = configCrypto({ source: { client: client('app') } });

    const reference = await controlPlane.seal('hunter2', entry);
    expect(reference.ciphertext.startsWith('agora:ct1:config-root:1:')).toBe(true);
    expect(await app.open(reference, entry)).toBe('hunter2');

    // The control plane never gets to read, and the app never gets to write.
    await expect(controlPlane.open(reference, entry)).rejects.toMatchObject({ status: 403 });
    await expect(app.seal('nope', entry)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a tampered reference and another entry’s context over HTTP', async () => {
    const { client } = await platform();
    const controlPlane = configCrypto({ source: { client: client('control-plane') } });
    const app = configCrypto({ source: { client: client('app') } });
    const reference = await controlPlane.seal('hunter2', entry);

    const tampered = {
      key: reference.key,
      ciphertext: `${reference.ciphertext.slice(0, -2)}aa`,
    };
    await expect(app.open(tampered, entry)).rejects.toMatchObject({ status: 400 });
    await expect(app.open(reference, { ...entry, key: 'db.user' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('honours an allow-list of reference keys (a rotation window)', async () => {
    const { client } = await platform();
    const controlPlane = configCrypto({ source: { client: client('control-plane') } });
    const reference = await controlPlane.seal('hunter2', entry);
    const app = configCrypto({
      source: { client: client('app') },
      keys: ['config-root-2025', 'config-root'],
    });
    expect(await app.open(reference, entry)).toBe('hunter2');
    const strict = configCrypto({
      source: { client: client('app') },
      keys: ['config-root-2026'],
    });
    expect(() => strict.parseReference(reference)).toThrow(/not configured to open/);
  });
});

describe("config's own crypto: { kms } smoke, as a test", () => {
  it('seals a config secret in envelope mode, reports active, and keeps opening after a rotate', async () => {
    const crypto = memoryCrypto();
    await crypto.service.createKey(crypto.principal, { name: 'config-root', type: 'aes256-gcm' });
    const source = { service: crypto.service, partition: 'shop' } as const;

    // What config's createConfigKeyring does: purpose config:secrets + the kms adapter.
    const withKms = createKeyring({
      purpose: 'config:secrets',
      keys: ['a-key-for-config-of-32-characters!!!'],
      kms: configKms({ source }),
    });
    const sealed = await seal(withKms, JSON.stringify('hunter2'), {
      aad: 'config:streaming:production:db.password',
    });
    expect(sealed.startsWith('agora:v1:kms:')).toBe(true);
    expect(await open(withKms, sealed, { aad: 'config:streaming:production:db.password' })).toBe(
      JSON.stringify('hunter2'),
    );
    expect(
      await sealedStatus(withKms, sealed, { aad: 'config:streaming:production:db.password' }),
    ).toBe('active');

    await crypto.service.rotateKey(crypto.principal, 'config-root');
    expect(await open(withKms, sealed, { aad: 'config:streaming:production:db.password' })).toBe(
      JSON.stringify('hunter2'),
    );
    const fresh = await seal(withKms, JSON.stringify('next'), {
      aad: 'config:streaming:production:db.password',
    });
    expect(fresh).not.toBe(sealed);
    expect(await open(withKms, fresh, { aad: 'config:streaming:production:db.password' })).toBe(
      JSON.stringify('next'),
    );

    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 50 });
    expect(
      audit.data.some(
        (row) => row.key === 'config-root' && row.operation === 'encrypt' && row.version === 2,
      ),
    ).toBe(true);
    expect(JSON.stringify(audit.data)).not.toContain('hunter2');
  });
});
