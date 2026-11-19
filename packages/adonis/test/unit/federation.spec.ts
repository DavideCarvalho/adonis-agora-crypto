import { describe, expect, it } from 'vitest';
import { CryptoService } from '../../src/crypto/service.js';
import { normalizeConsoleAuthorizeResult } from '../../src/dashboard/console_authorize.js';
import { resolveDashboardConfig } from '../../src/dashboard/define_config.js';
import {
  cryptoConsoleCommandHandler,
  FederatedCryptoApp,
  keyTestCapabilities,
  readOnlyCryptoStore,
  testKey,
  UNSUPPORTED,
  validateFederatedCryptoApp,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import { testKeyring } from '../../src/testing/index.js';
import { RedisBus } from '../support/redis_bus.js';

const admin = { partition: 'et', capabilities: ['crypto:*'], actor: 'seed' };

async function owner(options: { actions?: boolean; capabilities?: string[] } = {}) {
  const store = new MemoryStore();
  const service = new CryptoService({ store, keyring: testKeyring() });
  await service.createKey(admin, { name: 'orders', type: 'aes256-gcm', exportable: true });
  const handler = cryptoConsoleCommandHandler({
    service,
    actions: options.actions ?? true,
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    partitions: ['et'],
  });
  return { store, service, handler };
}

const command = (
  verb: string,
  body: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  id: 'c1',
  verb,
  args: [{ partition: 'et', name: 'orders', ...body }],
  actor: 'ana',
  via: 'Hub',
  ...extra,
});

describe('cryptoConsoleCommandHandler', () => {
  it('has no export command, and refuses unknown verbs as unsupported', async () => {
    const { handler } = await owner();
    await expect(handler(command('exportKey', {}))).rejects.toMatchObject({ code: UNSUPPORTED });
    await expect(handler(command('decrypt', {}))).rejects.toMatchObject({ code: UNSUPPORTED });
  });

  it('only touches the partitions it serves', async () => {
    const { handler } = await owner();
    await expect(handler(command('rotateKey', { partition: 'other' }))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('records the viewer as actor and the console as client', async () => {
    const { handler, service } = await owner();
    await handler(command('rotateKey', {}));
    const audit = await service.audit(admin, {
      page: 1,
      size: 5,
      filters: { operation: 'rotate' },
    });
    expect(audit.data[0]).toMatchObject({ actor: 'ana', clientId: 'console:Hub', result: 'ok' });
  });

  it("narrows to the viewer's grant: a key-scoped capability works for that key only", async () => {
    const { handler, service } = await owner();
    const scoped = { capabilities: ['crypto:encrypt:orders', 'crypto:decrypt:orders'] };
    await expect(handler(command('testKey', {}, scoped))).resolves.toMatchObject({ ok: true });
    await service.createKey(admin, { name: 'other', type: 'aes256-gcm' });
    await expect(handler(command('testKey', { name: 'other' }, scoped))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      handler(command('rotateKey', {}, { capabilities: ['crypto:keys:export'] })),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('testKey', () => {
  it('names what each key type needs and returns no secret', async () => {
    expect(keyTestCapabilities('k', 'ed25519')).toEqual(['crypto:sign:k', 'crypto:verify:k']);
    expect(keyTestCapabilities('k', 'hmac-sha256')).toEqual(['crypto:hmac:k']);
    expect(keyTestCapabilities('k', 'aes256-gcm')).toEqual([
      'crypto:encrypt:k',
      'crypto:decrypt:k',
    ]);
    const { service } = await owner();
    const result = await testKey(service, admin, 'orders');
    expect(result).toEqual({
      key: 'orders',
      type: 'aes256-gcm',
      version: 1,
      ok: true,
      operations: ['encrypt', 'decrypt'],
    });
    await expect(testKey(service, admin, 'missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('the federated read side', () => {
  it('drops the material, ignores audit appends and refuses writes', async () => {
    const { store } = await owner();
    const reader = readOnlyCryptoStore(store);
    expect((await reader.versions('et', 'orders'))[0]?.sealed).toBe('');
    expect((await store.versions('et', 'orders'))[0]?.sealed).not.toBe('');
    await reader.appendAudit({} as never);
    await expect(reader.deleteKey('et', 'orders', 'n', 'a')).rejects.toThrow(/through that app/);
  });

  it('a read-only federated app refuses operations before asking', async () => {
    const bus = new RedisBus();
    const app = new FederatedCryptoApp({
      id: 'et',
      actions: false,
      store: new MemoryStore(),
      channel: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
    });
    await expect(app.rotateKey('orders', { actor: 'ana' })).rejects.toMatchObject({ status: 403 });
    expect(bus.published).toEqual([]);
  });

  it('its service has no root key to open anything with', async () => {
    const { store } = await owner();
    const app = new FederatedCryptoApp({
      id: 'et',
      store,
      channel: new RedisConsoleChannel({ client: new RedisBus().connection(), prefix: 'et' }),
    });
    await expect(
      app.service.encrypt(
        { partition: 'et', capabilities: ['crypto:*'], actor: 'x' },
        { key: 'orders', plaintext: 'p' },
      ),
    ).rejects.toThrow();
  });
});

describe('federatedApps config', () => {
  const redis = { names: ['main'], default: 'main' };
  const entry = { store: { connection: 'et' }, controlPlane: { prefix: 'et' } };

  it('accepts a complete entry and refuses broken ones at boot', () => {
    expect(() => validateFederatedCryptoApp('et', entry, redis)).not.toThrow();
    expect(() => validateFederatedCryptoApp('bad key', entry, redis)).toThrow(/key/);
    expect(() =>
      validateFederatedCryptoApp('et', { ...entry, controlPlane: { prefix: '' } }, redis),
    ).toThrow(/prefix/);
    expect(() => validateFederatedCryptoApp('et', entry, undefined)).toThrow(/@adonisjs\/redis/);
  });

  it('keeps federatedApps and appLabel, and the authorizer capabilities', () => {
    const resolved = resolveDashboardConfig({ federatedApps: { et: entry }, appLabel: 'Hub' });
    expect(resolved.federatedApps).toEqual({ et: entry });
    expect(resolved.appLabel).toBe('Hub');
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, capabilities: ['crypto:keys:read', 2] }),
    ).toEqual({ allowed: true, capabilities: ['crypto:keys:read'] });
  });
});
