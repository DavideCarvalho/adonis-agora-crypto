import { randomBytes } from 'node:crypto';
import { CryptoError, type CryptoKeyType, type PublicJwk } from '@adonis-agora/crypto-core';
import { generateKeyPair, type Keyring, type OkpJwk, open, seal } from '../crypto-kit/index.js';
import { keyMaterialAad } from './keyring.js';

/**
 * One version's key material, in memory only. `aes256-gcm` and `hmac-sha256` are 32 random bytes
 * (base64url); the asymmetric types are the kit's OKP JWKs (the pair lives together, and only the
 * private one is sealed).
 */
export type KeyMaterial =
  | { kind: 'aes256-gcm'; key: string }
  | { kind: 'hmac-sha256'; key: string }
  | { kind: 'x25519'; privateKey: OkpJwk; publicKey: OkpJwk }
  | { kind: 'ed25519'; privateKey: OkpJwk; publicKey: OkpJwk };

/** What the store keeps sealed: the material plus the public metadata. */
export interface SealedMaterial {
  /** `agora:v1:…`: the kit's sealed value. */
  sealed: string;
  kid?: string;
  publicKey?: PublicJwk;
}

export function generateMaterial(type: CryptoKeyType): KeyMaterial {
  if (type === 'aes256-gcm' || type === 'hmac-sha256') {
    return { kind: type, key: randomBytes(32).toString('base64url') };
  }
  const pair = generateKeyPair(type);
  return { kind: type, privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/** Seals the material with the server's keyring, bound to its app, key name and version. */
export async function sealMaterial(
  keyring: Keyring,
  partition: string,
  name: string,
  version: number,
  material: KeyMaterial,
): Promise<SealedMaterial> {
  const aad = keyMaterialAad(partition, name, version);
  if (material.kind === 'aes256-gcm' || material.kind === 'hmac-sha256') {
    return { sealed: await seal(keyring, JSON.stringify({ key: material.key }), { aad }) };
  }
  return {
    sealed: await seal(keyring, JSON.stringify(material.privateKey), { aad }),
    kid: material.publicKey.kid,
    publicKey: publicJwkOf(material.publicKey),
  };
}

/** Opens one version's material. A wrong key, a moved row or tampering is `unreadable`. */
export async function openMaterial(
  keyring: Keyring,
  partition: string,
  name: string,
  version: number,
  type: CryptoKeyType,
  sealed: string,
): Promise<KeyMaterial> {
  let text: string;
  try {
    text = await open(keyring, sealed, { aad: keyMaterialAad(partition, name, version) });
  } catch (error) {
    throw new CryptoError(
      'unreadable',
      `crypto: key material for "${name}" v${version} could not be opened (${(error as Error).message})`,
    );
  }
  try {
    if (type === 'aes256-gcm' || type === 'hmac-sha256') {
      const parsed = JSON.parse(text) as { key?: unknown };
      if (typeof parsed.key !== 'string' || parsed.key === '') throw new Error('no key');
      return { kind: type, key: parsed.key };
    }
    const privateKey = JSON.parse(text) as OkpJwk;
    if (privateKey?.kty !== 'OKP' || typeof privateKey.d !== 'string') throw new Error('no d');
    return { kind: type, privateKey, publicKey: publicJwkOf(privateKey) };
  } catch {
    throw new CryptoError(
      'unreadable',
      `crypto: key material for "${name}" v${version} is not a ${type} key`,
    );
  }
}

/** The public half as the wire type (drops `d` and the kit's extra fields stay). */
export function publicJwkOf(jwk: OkpJwk): PublicJwk {
  const { d: _d, ...rest } = jwk;
  return rest;
}

/** The exportable form of a material: a base64url key, or the private JWK. */
export function exportableMaterial(material: KeyMaterial): {
  material: string | Record<string, unknown>;
  kid?: string;
} {
  if (material.kind === 'aes256-gcm' || material.kind === 'hmac-sha256') {
    return { material: material.key };
  }
  return {
    material: { ...material.privateKey },
    kid: material.privateKey.kid,
  };
}

/** The raw key bytes a symmetric material holds. */
export function symmetricKeyOf(material: KeyMaterial): Buffer {
  if (material.kind !== 'aes256-gcm' && material.kind !== 'hmac-sha256') {
    throw new CryptoError('unsupported', 'crypto: this operation needs a symmetric key');
  }
  return Buffer.from(material.key, 'base64url');
}
