import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isValidKeyName } from '@adonis-agora/crypto-core';
import { SubjectKeyError } from './errors.js';

/**
 * The wire format of a value sealed locally with a subject's data key:
 *
 * ```
 * agora:se1:<subject key>:<data key id>:<base64url(iv ‖ ciphertext ‖ tag)>
 * ```
 *
 * - `subject key` is the key-encryption key on the control plane (`subject_42`). Key names cannot
 *   contain `:`, so the segments are unambiguous.
 * - `data key id` is 32 lowercase hex characters: the row of `crypto_data_keys` that holds the
 *   wrapped data key. It never changes, so rotating or rewrapping the subject key does not rewrite
 *   data.
 * - The body is AES-256-GCM with a random 96-bit IV and a 128-bit tag.
 *
 * The AAD binds the format version, the subject key, the data key id and the caller's `aad` (the
 * Lucid integration passes table, column and row id), so a ciphertext copied to another subject,
 * another data key, another row or another column does not open.
 */
export const SUBJECT_CIPHERTEXT_PREFIX = 'agora:se1:';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const DATA_KEY_ID = /^[0-9a-f]{32}$/;

export interface SubjectCiphertext {
  /** The subject key (key-encryption key) on the control plane. */
  key: string;
  /** The data key id (`crypto_data_keys.id`). */
  dataKeyId: string;
}

/** A new data key id: 128 random bits, lowercase hex. */
export function newDataKeyId(): string {
  return randomBytes(16).toString('hex');
}

export function isDataKeyId(value: unknown): value is string {
  return typeof value === 'string' && DATA_KEY_ID.test(value);
}

/** Whether a value carries the subject-ciphertext prefix (it may still be malformed). */
export function isSubjectCiphertext(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SUBJECT_CIPHERTEXT_PREFIX);
}

/** The subject key and data key a ciphertext names, or `undefined` when it is not a well-formed one. */
export function readSubjectCiphertext(value: unknown): SubjectCiphertext | undefined {
  if (!isSubjectCiphertext(value)) return undefined;
  const parts = value.slice(SUBJECT_CIPHERTEXT_PREFIX.length).split(':');
  if (parts.length !== 3) return undefined;
  const [key, dataKeyId, body] = parts as [string, string, string];
  if (!isValidKeyName(key) || !isDataKeyId(dataKeyId) || !/^[A-Za-z0-9_-]+$/.test(body)) {
    return undefined;
  }
  return { key, dataKeyId };
}

/** The GCM additional data: everything the ciphertext is bound to, unambiguously encoded. */
function aadOf(key: string, dataKeyId: string, aad: string | undefined): Buffer {
  return Buffer.from(JSON.stringify(['agora:se1', key, dataKeyId, aad ?? null]), 'utf8');
}

/** Seals `plaintext` with a 32-byte data key. */
export function sealWithDataKey(
  dataKey: Buffer,
  plaintext: string,
  context: { key: string; dataKeyId: string; aad?: string | undefined },
): string {
  if (dataKey.length !== 32) throw new SubjectKeyError('invalid', 'crypto: a data key is 32 bytes');
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadOf(context.key, context.dataKeyId, context.aad));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  return `${SUBJECT_CIPHERTEXT_PREFIX}${context.key}:${context.dataKeyId}:${sealed}`;
}

/** Opens a {@link sealWithDataKey} ciphertext. Anything tampered, moved or mismatched is `invalid`. */
export function openWithDataKey(
  dataKey: Buffer,
  ciphertext: string,
  context: { key: string; dataKeyId: string; aad?: string | undefined },
): string {
  const parsed = readSubjectCiphertext(ciphertext);
  if (!parsed) throw new SubjectKeyError('invalid', 'crypto: not an agora:se1 ciphertext');
  if (parsed.key !== context.key || parsed.dataKeyId !== context.dataKeyId) {
    throw new SubjectKeyError('invalid', 'crypto: the ciphertext belongs to another data key');
  }
  const encoded = ciphertext.slice(ciphertext.lastIndexOf(':') + 1);
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.toString('base64url') !== encoded || bytes.length < IV_BYTES + TAG_BYTES) {
    throw new SubjectKeyError('invalid', 'crypto: malformed agora:se1 ciphertext');
  }
  const iv = bytes.subarray(0, IV_BYTES);
  const tag = bytes.subarray(bytes.length - TAG_BYTES);
  const body = bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES);
  try {
    const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aadOf(context.key, context.dataKeyId, context.aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
  } catch {
    throw new SubjectKeyError(
      'invalid',
      'crypto: the ciphertext did not open (tampered, moved to another row or column, or the wrong aad)',
    );
  }
}
