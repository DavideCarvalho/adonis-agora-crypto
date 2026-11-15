import { type BrowserKeyPair, generateKeyPair, publicJwk } from './browser.js';

/** Where a user's sealed identity is kept. Default: `localStorage`. */
export interface IdentityStorage {
  get(): Promise<string | null>;
  set(value: string | null): Promise<void>;
}

export function localStorageIdentityStorage(key = 'agora.crypto.identity'): IdentityStorage {
  return {
    async get() {
      try {
        return globalThis.localStorage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    async set(value) {
      try {
        if (value === null) globalThis.localStorage?.removeItem(key);
        else globalThis.localStorage?.setItem(key, value);
      } catch {
        // A private-mode browser without storage: the identity lives for the session only.
      }
    },
  };
}

/** The stored document: a passphrase-sealed private key, plus the public half for convenience. */
interface SealedIdentity {
  v: 1;
  /** PBKDF2-SHA256 iterations. */
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  publicKey: BrowserKeyPair['publicKey'];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toB64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64 = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as never, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Generates a browser identity: an X25519 key pair whose private half never leaves the device
 * unsealed. Register `publicKey` with the app (it is safe to store and publish).
 */
export function createBrowserIdentity(): BrowserKeyPair {
  return generateKeyPair();
}

/**
 * Seals the identity with a passphrase the user knows (PBKDF2-SHA256 + AES-256-GCM). Store the
 * returned string wherever the app keeps session-local state; `openBrowserIdentity` reverses it.
 */
export async function sealBrowserIdentity(
  identity: BrowserKeyPair,
  passphrase: string,
  options: { iterations?: number } = {},
): Promise<string> {
  if (passphrase.length < 8)
    throw new Error('crypto: the passphrase must be at least 8 characters');
  const iterations = options.iterations ?? 210_000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, iterations);
  const plaintext = encoder.encode(JSON.stringify(identity.privateKey));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as never }, key, plaintext),
  );
  const document: SealedIdentity = {
    v: 1,
    iterations,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
    publicKey: publicJwk(identity.privateKey),
  };
  return JSON.stringify(document);
}

/** Opens what {@link sealBrowserIdentity} produced. A wrong passphrase fails without a hint. */
export async function openBrowserIdentity(
  sealed: string,
  passphrase: string,
): Promise<BrowserKeyPair> {
  let document: SealedIdentity;
  try {
    document = JSON.parse(sealed) as SealedIdentity;
  } catch {
    throw new Error('crypto: the stored identity is not readable');
  }
  if (document.v !== 1) throw new Error('crypto: unknown identity version');
  const salt = fromB64(document.salt);
  const iv = fromB64(document.iv);
  const key = await deriveKey(passphrase, salt, document.iterations);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as never },
      key,
      fromB64(document.ciphertext) as never,
    );
    const privateKey = JSON.parse(decoder.decode(plaintext)) as BrowserKeyPair['privateKey'];
    return { privateKey, publicKey: publicJwk(privateKey) };
  } catch {
    throw new Error('crypto: wrong passphrase (or the stored identity is damaged)');
  }
}

export interface StoredIdentity {
  /** The public half, readable without unlocking (safe to show and register). */
  publicKey: BrowserKeyPair['publicKey'] | null;
}

/** Reads the public half of a stored identity without the passphrase. */
export async function storedPublicKey(
  storage: IdentityStorage,
): Promise<BrowserKeyPair['publicKey'] | null> {
  const raw = await storage.get();
  if (raw === null) return null;
  try {
    const document = JSON.parse(raw) as SealedIdentity;
    return document.publicKey ?? null;
  } catch {
    return null;
  }
}
