import { describe, expect, it } from 'vitest';
import { createKeyring, open, seal } from '../../adonis/src/crypto-kit/index.js';
import { memoryCrypto } from '../../adonis/src/testing/index.js';
import { agentPoppyKms, agentPoppyKmsCheck } from '../src/agent.js';
import { authkitKms, authkitKmsCheck } from '../src/authkit.js';
import { configKms, configKmsCheck } from '../src/config.js';

function setup() {
  const crypto = memoryCrypto();
  return { crypto, source: { service: crypto.service, partition: 'shop' } as const };
}

async function key(crypto: ReturnType<typeof memoryCrypto>, name: string, type = 'aes256-gcm') {
  await crypto.service.createKey(crypto.principal, { name, type: type as 'aes256-gcm' });
}

describe('KMS roots', () => {
  it('plugs each lib into the crypto-kit envelope and keeps libs apart', async () => {
    const { crypto, source } = setup();
    await key(crypto, 'authkit-root');
    await key(crypto, 'config-root');

    const authkitKeyring = createKeyring({
      purpose: 'authkit:keystore',
      keys: ['a-test-app-key-of-32-characters!!!'],
      kms: authkitKms({ source }),
    });
    const configKeyring = createKeyring({
      purpose: 'config:secrets',
      keys: ['a-test-app-key-of-32-characters!!!'],
      kms: configKms({ source }),
    });

    const jwt = await seal(authkitKeyring, '{"d":"private-jwk"}', { aad: 'keystore:1' });
    expect(jwt.startsWith('agora:v1:kms:')).toBe(true);
    expect(await open(authkitKeyring, jwt, { aad: 'keystore:1' })).toBe('{"d":"private-jwk"}');
    // A value sealed under authkit's purpose does not open under config's.
    await expect(open(configKeyring, jwt, { aad: 'keystore:1' })).rejects.toBeDefined();

    // The audit trail shows the wraps under the lib's key, never the value.
    const audit = await crypto.service.audit(crypto.principal, { page: 1, size: 50 });
    expect(audit.data.some((row) => row.key === 'authkit-root')).toBe(true);
    expect(JSON.stringify(audit.data)).not.toContain('private-jwk');
  });

  it('uses each lib’s key convention, and a custom key when given', async () => {
    const { crypto, source } = setup();
    await key(crypto, 'authkit-root');
    await key(crypto, 'agent-poppy-root');
    const agentKeyring = createKeyring({
      purpose: 'agent:poppy-connections',
      keys: ['a-test-app-key-of-32-characters!!!'],
      kms: agentPoppyKms({ source }),
    });
    const sealed = await seal(agentKeyring, 'refresh-token', { aad: 'conn:1' });
    expect(await open(agentKeyring, sealed, { aad: 'conn:1' })).toBe('refresh-token');

    await key(crypto, 'custom-root');
    const custom = createKeyring({
      purpose: 'config:secrets',
      keys: ['a-test-app-key-of-32-characters!!!'],
      kms: configKms({ source, key: 'custom-root' }),
    });
    expect(await open(custom, await seal(custom, 'x', {}), {})).toBe('x');
  });

  it('fails loudly when the key is missing or of the wrong type', async () => {
    const { crypto, source } = setup();
    await key(crypto, 'agent-poppy-root', 'x25519');
    const authkit = await authkitKmsCheck({ source }).run({} as never);
    expect(authkit.status).toBe('error');
    expect(authkit.message).toMatch(/no key "authkit-root"/);
    expect(authkit.fix).toMatch(/crypto:keys:create authkit-root --type aes256-gcm/);

    const wrongType = await agentPoppyKmsCheck({ source }).run({} as never);
    expect(wrongType.status).toBe('error');
    expect(wrongType.message).toMatch(/must be aes256-gcm/);
  });

  it('reports a token that cannot use the key (403) and an ok round trip', async () => {
    const { crypto } = setup();
    await key(crypto, 'config-root');
    const denied = {
      source: {
        client: {
          getKey: async () => ({ type: 'aes256-gcm', latestVersion: 1 }),
          encrypt: async () => {
            throw Object.assign(new Error('crypto: the token lacks crypto:encrypt:config-root'), {
              status: 403,
            });
          },
          decrypt: async () => ({ plaintext: '' }),
        },
      } as never,
    };
    const deniedResult = await configKmsCheck(denied).run({} as never);
    expect(deniedResult.status).toBe('error');
    expect(deniedResult.message).toMatch(/403/);
    expect(deniedResult.fix).toMatch(/crypto:encrypt:config-root/);

    const ok = await configKmsCheck({ source: { service: crypto.service, partition: 'shop' } }).run(
      {} as never,
    );
    expect(ok.status).toBe('ok');
    expect(ok.message).toMatch(/"config-root" exists \(aes256-gcm, v1\)/);
  });

  it('names the check after its lib, with the rc package', () => {
    const { source } = setup();
    expect(authkitKmsCheck({ source })).toMatchObject({
      id: 'authkit.kms',
      lib: 'authkit',
      package: '@adonis-agora/authkit-server',
      cost: 'deep',
    });
    expect(agentPoppyKmsCheck({ source })).toMatchObject({ id: 'agent.kms', lib: 'agent' });
    expect(configKmsCheck({ source })).toMatchObject({
      id: 'config.kms',
      package: '@adonis-agora/config',
    });
  });

  it('works against a remote client exactly like the embedded service', async () => {
    const { crypto } = setup();
    await key(crypto, 'config-root');
    const calls: string[] = [];
    const client = {
      getKey: (name: string) => crypto.service.getKey(crypto.principal, name),
      encrypt: (input: never) => {
        calls.push('encrypt');
        return crypto.service.encrypt(crypto.principal, input);
      },
      decrypt: (input: never) => {
        calls.push('decrypt');
        return crypto.service.decrypt(crypto.principal, input);
      },
    };
    const keyring = createKeyring({
      purpose: 'config:secrets',
      keys: ['a-test-app-key-of-32-characters!!!'],
      kms: configKms({ source: { client } as never }),
    });
    expect(await open(keyring, await seal(keyring, 'remote', {}), {})).toBe('remote');
    expect(calls).toEqual(['encrypt', 'wrap'.replace('wrap', 'decrypt')]);
  });
});
