import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories';
import type { ApplicationService } from '@adonisjs/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CryptoKeysCreate,
  CryptoKeysDelete,
  CryptoKeysList,
  CryptoKeysPolicy,
  CryptoKeysPublicKey,
  CryptoKeysRotate,
  CryptoKeysShow,
} from '../../commands/keys.js';
import CryptoEncrypt, { CryptoAuditCommand, CryptoDecrypt } from '../../commands/ops.js';
import { defineConfig, stores } from '../../src/define_config.js';

import { CONSOLE_COMMAND_KEY, ensureConsoleCommandKey } from '../../src/federation/console.js';
import type { CryptoRuntime } from '../../src/runtime.js';

/** The crypto:* commands through the real ace kernel of a booted server. */
describe('commands', () => {
  let app: ApplicationService;
  let writes: string[];

  beforeEach(async () => {
    mkdirSync(join(process.cwd(), 'test/unit/tmp'), { recursive: true });
    const ignitor = new IgnitorFactory()
      .merge({
        rcFileContents: { providers: [() => import('../../providers/crypto_provider.js')] },
        config: {
          crypto: defineConfig({
            topology: 'control-plane',
            verifyTenant: async () => null,
            store: stores.memory(),
            crypto: { keys: [{ id: 'root', secret: 'a-test-root-key-of-32-characters!' }] },
            console: false,
          }),
        },
      })
      .withCoreConfig()
      .withCoreProviders()
      .create(new URL('./tmp/', import.meta.url));
    app = ignitor.createApp('console') as ApplicationService;
    await app.init();
    await app.boot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.terminate();
  });

  async function run(command: never, args: string[]) {
    writes = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const ace = await app.container.make('ace');
    const instance = await ace.create(command, args);
    instance.ui.switchMode('raw');
    await instance.exec();
    return { instance, json: () => JSON.parse(writes.join('')) };
  }

  it('creates, lists, shows, rotates and policies a key', async () => {
    const created = await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'aes256-gcm',
      '--description',
      'media URLs',
      '--application',
      'shop',
      '--json',
    ]);
    expect(created.instance.exitCode).toBe(0);
    expect(created.json()).toMatchObject({
      partition: 'shop',
      name: 'media',
      type: 'aes256-gcm',
      description: 'media URLs',
      latestVersion: 1,
    });

    const listed = await run(CryptoKeysList as never, ['--application', 'shop', '--json']);
    expect(listed.json().data).toHaveLength(1);

    const rotated = await run(CryptoKeysRotate as never, [
      'media',
      '--application',
      'shop',
      '--json',
    ]);
    expect(rotated.json()).toMatchObject({ latestVersion: 2 });

    const policy = await run(CryptoKeysPolicy as never, [
      'media',
      '--application',
      'shop',
      '--min-decryption-version',
      '2',
      '--exportable',
      '--json',
    ]);
    expect(policy.json()).toMatchObject({ minDecryptionVersion: 2, exportable: true });

    const shown = await run(CryptoKeysShow as never, ['media', '--application', 'shop', '--json']);
    expect(shown.json().versions).toHaveLength(2);
    expect(shown.json().versions[0]).toMatchObject({ status: 'retired' });
  });

  it('prints the public JWK of an asymmetric key, or every version as a JWKS', async () => {
    await run(CryptoKeysCreate as never, ['inbox', '--type', 'x25519', '--application', 'shop']);
    await run(CryptoKeysPublicKey as never, ['inbox', '--application', 'shop']);
    const parsed = JSON.parse(writes.join('')) as { crv: string; x: string; kid: string };
    expect(parsed.crv).toBe('X25519');
    expect(parsed.kid).toBeTypeOf('string');

    await run(CryptoKeysRotate as never, ['inbox', '--application', 'shop']);
    await run(CryptoKeysPublicKey as never, ['inbox', '--application', 'shop', '--jwks']);
    expect((JSON.parse(writes.join('')) as { keys: unknown[] }).keys).toHaveLength(2);
  });

  it('prints the console-commands key (token mode) the boot log names by a short id', async () => {
    const runtime = (await app.container.make('agora.crypto')) as CryptoRuntime;
    await ensureConsoleCommandKey(runtime.service!, 'shop');
    await run(CryptoKeysPublicKey as never, [CONSOLE_COMMAND_KEY, '--application', 'shop']);
    const jwk = JSON.parse(writes.join('')) as { kty: string; crv: string; x: string; kid: string };
    expect(jwk).toMatchObject({ kty: 'OKP', crv: 'X25519' });
    expect(jwk.kid).toBeTypeOf('string');
    await run(CryptoKeysPublicKey as never, [
      CONSOLE_COMMAND_KEY,
      '--application',
      'shop',
      '--jwks',
    ]);
    expect((JSON.parse(writes.join('')) as { keys: Array<{ kid: string }> }).keys[0]?.kid).toBe(
      jwk.kid,
    );
  });

  it('refuses an unknown type before touching the store', async () => {
    const created = await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'rsa',
      '--application',
      'shop',
    ]);
    expect(created.instance.exitCode).toBe(1);
  });

  it('encrypts and decrypts through the ops commands', async () => {
    await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'aes256-gcm',
      '--application',
      'shop',
    ]);
    const encrypted = await run(CryptoEncrypt as never, [
      '--key',
      'media',
      '--value',
      'hello',
      '--aad',
      'row-1',
      '--json',
    ]);
    expect(encrypted.instance.exitCode).toBe(0);
    const ciphertext = encrypted.json().ciphertext as string;
    expect(ciphertext.startsWith('agora:ct1:media:1:')).toBe(true);

    await run(CryptoDecrypt as never, ['--key', 'media', '--value', ciphertext, '--aad', 'row-1']);
    expect(writes.join('')).toBe('hello\n');
  });

  it('fails loudly on a decryption that cannot work', async () => {
    await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'aes256-gcm',
      '--application',
      'shop',
    ]);
    const failed = await run(CryptoDecrypt as never, [
      '--key',
      'media',
      '--value',
      'agora:ct1:media:1:not-real',
    ]);
    expect(failed.instance.exitCode).toBe(1);
  });

  it('shows the audit trail and deletes only with --force', async () => {
    await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'aes256-gcm',
      '--deletion-allowed',
      '--application',
      'shop',
    ]);
    const audit = await run(CryptoAuditCommand as never, ['--application', 'shop', '--json']);
    const rows = audit.json().data as Array<{ operation: string; actor: string }>;
    expect(rows[0]).toMatchObject({ operation: 'create', actor: expect.stringMatching(/^cli:/) });

    const deleted = await run(CryptoKeysDelete as never, [
      'media',
      '--application',
      'shop',
      '--force',
      '--json',
    ]);
    expect(deleted.json()).toEqual({ key: 'media', deleted: true });
  });

  it('refuses to delete a key that does not allow it', async () => {
    await run(CryptoKeysCreate as never, [
      'media',
      '--type',
      'aes256-gcm',
      '--application',
      'shop',
    ]);
    const refused = await run(CryptoKeysDelete as never, [
      'media',
      '--application',
      'shop',
      '--force',
    ]);
    expect(refused.instance.exitCode).toBe(1);
  });
});
