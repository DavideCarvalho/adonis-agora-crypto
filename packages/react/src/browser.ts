/**
 * The asymmetric half of the Agora crypto kit, in the browser: X25519 key pairs and the
 * `agora:pk1` sealed envelope, byte-for-byte compatible with the kit's `sealTo`/`openWith`.
 *
 * It uses `@noble/curves` (X25519), `@noble/hashes` (SHA-256/HKDF) and `@noble/ciphers`
 * (AES-256-GCM) — no Node built-ins — so the same code runs in a React app, a worker or a test.
 */

import type { PublicJwk } from '@adonis-agora/crypto-core';
import { gcm } from '@noble/ciphers/aes.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** An OKP key pair as JWKs, the shape the crypto server publishes and the kit understands. */
export interface BrowserKeyPair {
  publicKey: PublicJwk;
  privateKey: PublicJwk & { d: string };
}

const SEALED_TO_PREFIX = 'agora:pk1:';
const KID = /^[A-Za-z0-9._-]{1,128}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** RFC 7638 thumbprint of an OKP key: the `kid` the kit computes. */
export function jwkThumbprint(key: Pick<PublicJwk, 'crv' | 'x'>): string {
  const canonical = JSON.stringify({ crv: key.crv, kty: 'OKP', x: key.x });
  return toBase64Url(sha256(encoder.encode(canonical)));
}

/** A fresh X25519 pair; `kid` defaults to the thumbprint of the public half. */
export function generateKeyPair(options: { kid?: string } = {}): BrowserKeyPair {
  const secret = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(secret);
  const x = toBase64Url(publicKey);
  const kid = options.kid ?? jwkThumbprint({ crv: 'X25519', x });
  if (!KID.test(kid)) throw new Error('crypto: kid must match [A-Za-z0-9._-]{1,128}');
  const publicJwk: PublicJwk = {
    kty: 'OKP',
    crv: 'X25519',
    x,
    kid,
    use: 'enc',
    alg: 'ECDH-ES',
  };
  return {
    publicKey: publicJwk,
    privateKey: { ...publicJwk, d: toBase64Url(secret) },
  };
}

/** The public half of a pair (drops `d`). */
export function publicJwk(key: PublicJwk & { d?: string }): PublicJwk {
  const { d: _d, ...rest } = key;
  return rest;
}

const contentKey = (shared: Uint8Array, kid: string, ephemeralX: string, recipientX: string) =>
  hkdf(
    sha256,
    shared,
    new Uint8Array(0),
    encoder.encode(JSON.stringify(['agora:pk1', kid, ephemeralX, recipientX])),
    32,
  );

const aadOf = (kid: string, aad: string | undefined) =>
  encoder.encode(JSON.stringify(['agora:pk1', kid, aad ?? null]));

export interface SealOptions {
  /** Additional authenticated data: the same string must reach `openWith`. */
  aad?: string;
}

/**
 * Encrypts `value` so only the holder of the X25519 private key opens it:
 * `agora:pk1:<kid>:<ephemeral x>:<iv>:<tag>:<ciphertext>` — the kit's format, so a browser-sealed
 * share opens with the kit's `openWith`, and a kit-sealed one opens here.
 */
export function sealTo(recipient: PublicJwk, value: string, options: SealOptions = {}): string {
  if (recipient?.kty !== 'OKP' || recipient.crv !== 'X25519' || !KID.test(recipient.kid ?? '')) {
    throw new Error('crypto: sealTo() needs an X25519 public JWK with a kid');
  }
  const ephemeralSecret = x25519.utils.randomSecretKey();
  const ephemeralX = toBase64Url(x25519.getPublicKey(ephemeralSecret));
  const shared = x25519.getSharedSecret(ephemeralSecret, fromBase64Url(recipient.x));
  const key = contentKey(shared, recipient.kid, ephemeralX, recipient.x);
  const iv = randomBytes(12);
  const sealed = gcm(key, iv, aadOf(recipient.kid, options.aad)).encrypt(encoder.encode(value));
  const tag = sealed.slice(sealed.length - 16);
  const body = sealed.slice(0, sealed.length - 16);
  return `${SEALED_TO_PREFIX}${[
    recipient.kid,
    ephemeralX,
    toBase64Url(iv),
    toBase64Url(tag),
    toBase64Url(body),
  ].join(':')}`;
}

/** What an open produced, for the app's own audit: the value and which `kid` opened it. */
export interface OpenedShare<T = string> {
  value: T;
  /** The key version that opened the share (from the `agora:pk1` header). */
  kid: string;
  /** ISO timestamp of the open, to emit with the app's `crypto:sealed.open` event. */
  at: string;
}

/** The `kid` an `agora:pk1` value names, without opening it (for a grant list, a UI hint). */
export function sealedKid(sealed: string): string | undefined {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_TO_PREFIX)) return undefined;
  const kid = sealed.slice(SEALED_TO_PREFIX.length).split(':')[0];
  return kid && KID.test(kid) ? kid : undefined;
}

/**
 * Opens a share and returns what the app needs to audit it: the value, the `kid` used and the
 * timestamp. Pair it with `sealedOpenEvent(...)` from `@adonis-agora/crypto-integrations` (which
 * normalizes `actor ?? sub`) so the event matches the crypto server's audit identity.
 */
export function openWithAudit(
  privateKey: PublicJwk & { d?: string },
  sealed: string,
  options: SealOptions = {},
): OpenedShare {
  const kid = sealedKid(sealed);
  if (kid === undefined) throw new Error('crypto: not an agora:pk1 value');
  return { value: openWith(privateKey, sealed, options), kid, at: new Date().toISOString() };
}

/** Opens a {@link sealTo} value with the private key whose `kid` it names. */
export function openWith(
  privateKey: PublicJwk & { d?: string },
  sealed: string,
  options: SealOptions = {},
): string {
  if (typeof sealed !== 'string' || !sealed.startsWith(SEALED_TO_PREFIX)) {
    throw new Error('crypto: not an agora:pk1 value');
  }
  const [kid, ephemeralX, ivPart, tagPart, bodyPart, ...extra] = sealed
    .slice(SEALED_TO_PREFIX.length)
    .split(':');
  if (!kid || !KID.test(kid) || extra.length > 0) {
    throw new Error('crypto: malformed agora:pk1 value');
  }
  if (typeof privateKey.d !== 'string' || privateKey.kid !== kid) {
    throw new Error(`crypto: no X25519 private key with kid "${kid}"`);
  }
  const iv = fromBase64Url(ivPart ?? '');
  const tag = fromBase64Url(tagPart ?? '');
  const body =
    bodyPart === '' || bodyPart === undefined ? new Uint8Array(0) : fromBase64Url(bodyPart);
  const shared = x25519.getSharedSecret(
    fromBase64Url(privateKey.d),
    fromBase64Url(ephemeralX ?? ''),
  );
  const key = contentKey(shared, kid, ephemeralX ?? '', privateKey.x);
  const combined = new Uint8Array(body.length + tag.length);
  combined.set(body);
  combined.set(tag, body.length);
  try {
    return decoder.decode(gcm(key, iv, aadOf(kid, options.aad)).decrypt(combined));
  } catch {
    throw new Error('crypto: agora:pk1 value did not open (tampered or wrong aad)');
  }
}
