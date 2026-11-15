import type { AgoraDoctorCheck } from '@adonis-agora/crypto';
import { cryptoServerKms, type KmsAdapterLike } from '@adonis-agora/crypto-core';
import { type CipherSource, cipherFor } from './source.js';

/** Options every KMS integration shares: where the keys live, and which key is the root. */
export interface KmsIntegrationOptions {
  source: CipherSource;
  /** The root key's name. Each subpath defaults to its lib's convention (`authkit-root`, …). */
  key?: string;
  /**
   * Bind every wrapped data key to the keyring's `purpose` (the default). Keep it on: it is what
   * stops a data key wrapped for `config:secrets` from being unwrapped for another lib.
   */
  bindPurpose?: boolean;
}

/**
 * The crypto-kit `KmsAdapter` backed by the crypto server, under one key. Every value the lib seals
 * then carries a data key wrapped by that key: rotating it (`node ace crypto:keys:rotate <key>`)
 * rotates the whole fleet, and no key material lives in the app.
 */
export function kmsFor(key: string, options: KmsIntegrationOptions): KmsAdapterLike {
  return cryptoServerKms({
    client: cipherFor(options.source, `kms:${key}`),
    key,
    ...(options.bindPurpose !== undefined ? { bindPurpose: options.bindPurpose } : {}),
  });
}

export interface KmsCheckOptions extends KmsIntegrationOptions {
  /** The lib the check reports under (`authkit`, `agent`, `config`). */
  lib: string;
  /** The npm package the check names. */
  packageName: string;
  /** Check title. Default states the key. */
  title?: string;
}

/**
 * The `agora:doctor` check for a KMS root: the key exists, it is an `aes256-gcm` key, and this
 * process can actually encrypt and decrypt with it (the token's capabilities, the key material and
 * the crypto server itself). It is `deep`: it makes a round trip and leaves two audit rows.
 */
export function kmsDoctorCheck(options: KmsCheckOptions): AgoraDoctorCheck {
  const key = options.key ?? '';
  return {
    id: `${options.lib}.kms`,
    lib: options.lib,
    package: options.packageName,
    title: options.title ?? `KMS root "${key}"`,
    cost: 'deep',
    run: async () => {
      const cipher = cipherFor(options.source, 'doctor');
      let view: { type?: string; latestVersion?: number } | null;
      try {
        view = await describeKey(options.source, key);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 404) {
          return {
            status: 'error',
            message: `The crypto server has no key "${key}", so this app seals with a key that does not exist.`,
            fix: `Create it: node ace crypto:keys:create ${key} --type aes256-gcm (and grant this app crypto:encrypt:${key} / crypto:decrypt:${key}).`,
            docs: 'https://davidecarvalho.github.io/agora/docs/crypto/kms',
          };
        }
        return {
          status: 'error',
          message: `Could not read the key "${key}": ${(error as Error).message}`,
          fix: 'Check the crypto server URL and the token (whoami answers what the token may do).',
          docs: 'https://davidecarvalho.github.io/agora/docs/crypto/authentication',
        };
      }
      if (view === null) {
        return {
          status: 'error',
          message: `The crypto server has no key "${key}".`,
          fix: `Create it: node ace crypto:keys:create ${key} --type aes256-gcm.`,
          docs: 'https://davidecarvalho.github.io/agora/docs/crypto/kms',
        };
      }
      if (view.type !== 'aes256-gcm') {
        return {
          status: 'error',
          message: `The key "${key}" is ${view.type}; a KMS root must be aes256-gcm.`,
          fix: `Create an aes256-gcm key under a new name and point this integration at it.`,
          docs: 'https://davidecarvalho.github.io/agora/docs/crypto/keys',
        };
      }
      const probe = `agora:doctor:${Date.now()}`;
      try {
        const { ciphertext } = await cipher.encrypt({ key, plaintext: probe });
        const { plaintext } = await cipher.decrypt({ key, ciphertext });
        if (plaintext !== probe) {
          return {
            status: 'error',
            message: `The round trip through "${key}" came back different.`,
            fix: 'Check the root keyring of the crypto server (APP_KEY / crypto.keys / its KMS).',
            docs: 'https://davidecarvalho.github.io/agora/docs/crypto/keys',
          };
        }
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 403) {
          return {
            status: 'error',
            message: `The token cannot use "${key}" (403): the app's capabilities are missing.`,
            fix: `Grant crypto:encrypt:${key} and crypto:decrypt:${key} to this app's client.`,
            docs: 'https://davidecarvalho.github.io/agora/docs/crypto/authentication',
          };
        }
        return {
          status: 'error',
          message: `The round trip through "${key}" failed: ${(error as Error).message}`,
          fix: 'Check that the crypto server is up and its root keyring is the one that sealed this key.',
          docs: 'https://davidecarvalho.github.io/agora/docs/crypto/doctor',
        };
      }
      return {
        status: 'ok',
        message: `"${key}" exists (${view.type}, v${view.latestVersion ?? '?'}) and this process sealed and opened a value with it.`,
      };
    },
  };
}

/** Reads a key's metadata through whichever source is configured. */
async function describeKey(
  source: CipherSource,
  key: string,
): Promise<{ type?: string; latestVersion?: number } | null> {
  if ('client' in source) {
    const view = await source.client.getKey(key);
    return { type: view.type, latestVersion: view.latestVersion };
  }
  const view = await source.service.getKey(
    {
      partition: source.partition,
      capabilities: ['crypto:keys:read'],
      actor: source.actor ?? 'doctor',
    },
    key,
  );
  return { type: view.type, latestVersion: view.latestVersion };
}
