import { describe, expect, it } from 'vitest';
import {
  type ControlPlaneConfig,
  defineConfig,
  type StandaloneConfig,
} from '../../src/define_config.js';
import { MemoryStore } from '../../src/store/memory_store.js';
import type { CryptoStore } from '../../src/store/store.js';
import { resolveTenantVerifier, sharedSecretVerifier } from '../../src/topology/verify.js';

describe('defineConfig', () => {
  it('accepts a standalone app with a store factory', () => {
    const config: StandaloneConfig = defineConfig({
      app: 'shop',
      store: () => new MemoryStore(),
    }) as StandaloneConfig;
    expect(config.topology).toBeUndefined();
    expect(config.app).toBe('shop');
  });

  it('requires `app` on a standalone app', () => {
    expect(() => defineConfig({} as never)).toThrow(/`app` is required/);
  });

  it('requires verifyTenant on a control plane and refuses it elsewhere', () => {
    expect(() => defineConfig({ topology: 'control-plane' } as never)).toThrow(
      /needs `verifyTenant`/,
    );
    expect(() =>
      defineConfig({
        topology: 'control-plane',
        verifyTenant: 42 as never,
      }),
    ).toThrow(/must be a function/);
    expect(() =>
      defineConfig({
        app: 'shop',
        verifyTenant: sharedSecretVerifier({ partitions: {} }),
      } as never),
    ).toThrow(/only applies to topology "control-plane"/);
    const config = defineConfig({
      topology: 'control-plane',
      verifyTenant: sharedSecretVerifier({ partitions: { shop: 'secret' } }),
    }) as ControlPlaneConfig;
    expect(config.topology).toBe('control-plane');
  });

  it('validates a tenant: url, partition and token are required', () => {
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { partition: 'shop', token: 'secret', url: '' },
      }),
    ).toThrow(/url is required/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://crypto.example.com/_crypto', token: 'secret' },
      } as never),
    ).toThrow(/partition is required/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://crypto.example.com/_crypto', partition: 'shop' },
      } as never),
    ).toThrow(/token is required/);
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'crypto.example.com', partition: 'shop', token: 'secret' },
      }),
    ).toThrow(/absolute http\(s\) URL/);
    const config = defineConfig({
      topology: 'tenant',
      tenant: { url: 'https://crypto.example.com/_crypto', partition: 'shop', token: 'secret' },
    });
    expect(config.topology).toBe('tenant');
  });

  it('never lets a tenant hold a store or a keyring', () => {
    const config = defineConfig({
      topology: 'tenant',
      tenant: { url: 'https://x.test/_crypto', partition: 'shop', token: 'secret' },
      // The type says `never`; a JS caller must still not reach the server's store.
      store: (() => new MemoryStore()) as unknown as undefined,
    });
    expect(config.topology).toBe('tenant');
    expect((config as { store?: CryptoStore }).store).toBeDefined();
  });
});

describe('verifyTenant', () => {
  it('accepts the three forms, including a lazy import', async () => {
    const verifier = sharedSecretVerifier({ partitions: { shop: 'secret' } });
    const direct = await resolveTenantVerifier(verifier)({
      token: 'secret',
      app: 'shop',
    });
    expect(direct).toMatchObject({ partition: 'shop', capabilities: ['crypto:*'] });

    const object = await resolveTenantVerifier({
      verify: () => ({ partition: 'shop', capabilities: ['crypto:keys:read'] }),
    })({ token: 'x', app: 'shop' });
    expect(object).toMatchObject({ capabilities: ['crypto:keys:read'] });

    const lazy = await resolveTenantVerifier(async () => ({ default: verifier }))({
      token: 'secret',
      app: 'shop',
    });
    expect(lazy).toMatchObject({ partition: 'shop' });

    const classed = await resolveTenantVerifier(
      class {
        verify() {
          return { partition: 'shop', capabilities: [] };
        }
      },
    )({ token: 'x' });
    expect(classed).toEqual({ partition: 'shop', capabilities: [] });
  });

  it('refuses a malformed answer instead of accepting it', async () => {
    const resolved = resolveTenantVerifier(() => ({ tenant: 'shop' }) as never);
    await expect(resolved({ token: 'x' })).rejects.toThrow(/rename it to `partition`/);
  });

  it('compares the shared secret in constant time and defaults capabilities to crypto:*', () => {
    const verifier = sharedSecretVerifier({
      partitions: {
        shop: 'a'.repeat(24),
        billing: { secret: 'b'.repeat(24), capabilities: ['crypto:keys:read'], actor: 'agent:7' },
      },
    });
    expect(verifier({ token: 'a'.repeat(24), app: 'shop' })).toMatchObject({
      partition: 'shop',
      capabilities: ['crypto:*'],
    });
    expect(verifier({ token: 'wrong', app: 'shop' })).toBeNull();
    expect(verifier({ token: 'a'.repeat(24), app: 'unknown' })).toBeNull();
    expect(verifier({ token: 'a'.repeat(24) })).toBeNull();
    expect(verifier({ token: 'b'.repeat(24), app: 'billing' })).toMatchObject({
      capabilities: ['crypto:keys:read'],
      actor: 'agent:7',
    });
  });
});
