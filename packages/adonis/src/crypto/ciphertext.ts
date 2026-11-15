import { CryptoError } from '@adonis-agora/crypto-core';
import { gcmEncryption } from '../crypto-kit/index.js';

/**
 * The wire format of a symmetric ciphertext:
 *
 * ```
 * agora:ct1:<key>:<version>:<base64url of the Adonis AES-256-GCM ciphertext>
 * ```
 *
 * Self-describing, so `decrypt` knows which version sealed it (and can still open an older one
 * down to `minDecryptionVersion`), and so `rewrap` knows what it is re-encrypting. The key name
 * cannot contain `:`, and the Adonis payload is base64url'd, so the segments are unambiguous.
 *
 * The purpose (Adonis' AAD) binds the key name, the version and the caller's `aad`: a ciphertext
 * cannot be moved to another key, another version or another row.
 */
export const CIPHERTEXT_PREFIX = 'agora:ct1:';

export interface AeadContext {
  key: string;
  version: number;
  aad?: string | undefined;
}

/** Adonis' `purpose` for one ciphertext; it is the GCM additional authenticated data. */
export function aeadPurpose(context: AeadContext): string {
  return JSON.stringify(['agora:ct1', context.key, context.version, context.aad ?? null]);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

function decode(part: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return undefined;
  const bytes = Buffer.from(part, 'base64url');
  return b64(bytes) === part ? bytes : undefined;
}

/** Encrypts a string with one version's key material (base64url 32 bytes). */
export function sealAead(material: string, plaintext: string, context: AeadContext): string {
  const body = gcmEncryption([material]).encrypt(
    { v: plaintext },
    {
      purpose: aeadPurpose(context),
    },
  );
  const encoded = b64(Buffer.from(body, 'utf8'));
  return `${CIPHERTEXT_PREFIX}${context.key}:${context.version}:${encoded}`;
}

/** Reads the key name and version a ciphertext names. `undefined` when it is not one. */
export function readCiphertext(ciphertext: unknown): { key: string; version: number } | undefined {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(CIPHERTEXT_PREFIX)) return undefined;
  const [key, version] = ciphertext.slice(CIPHERTEXT_PREFIX.length).split(':');
  if (!key || !version || !/^[1-9][0-9]{0,9}$/.test(version)) return undefined;
  return { key, version: Number(version) };
}

/** Opens a {@link sealAead} ciphertext; a tampered or moved value is `unreadable`. */
export function openAead(material: string, ciphertext: string, context: AeadContext): string {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(CIPHERTEXT_PREFIX)) {
    throw new CryptoError('invalid', 'crypto: not an agora:ct1 ciphertext');
  }
  const parts = ciphertext.slice(CIPHERTEXT_PREFIX.length).split(':');
  if (parts.length !== 3)
    throw new CryptoError('invalid', 'crypto: malformed agora:ct1 ciphertext');
  const [key, versionText, encoded] = parts as [string, string, string];
  if (key !== context.key || Number(versionText) !== context.version) {
    throw new CryptoError('invalid', 'crypto: ciphertext belongs to another key or version');
  }
  const body = decode(encoded);
  if (!body) throw new CryptoError('invalid', 'crypto: malformed agora:ct1 ciphertext');
  const payload = gcmEncryption([material]).decrypt<{ v?: unknown }>(
    body.toString('utf8'),
    aeadPurpose(context),
  );
  const value = payload?.v;
  if (typeof value !== 'string') {
    throw new CryptoError(
      'invalid',
      'crypto: the ciphertext did not open (tampered, or the wrong aad)',
    );
  }
  return value;
}
