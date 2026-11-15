/**
 * `@adonis-agora/crypto-core` — the wire contract of the Agora crypto server: what a key is, which
 * capability gates which operation, and the shape of every request and answer. No I/O, no crypto,
 * no AdonisJS: the server, the client and every lib that talks to them share exactly these types.
 */

/** The resource (RFC 8707) every crypto server answers for: the `aud` of tenant tokens. */
export const CRYPTO_RESOURCE = 'urn:agora:crypto';

/** The key types a server can hold. */
export const CRYPTO_KEY_TYPES = ['aes256-gcm', 'x25519', 'ed25519', 'hmac-sha256'] as const;
export type CryptoKeyType = (typeof CRYPTO_KEY_TYPES)[number];

/** Types that encrypt and decrypt (`x25519` seals to a public key; the others are symmetric). */
export const ENCRYPTION_KEY_TYPES: readonly CryptoKeyType[] = ['aes256-gcm', 'x25519'];
/** Types that produce a detached signature. */
export const SIGNING_KEY_TYPES: readonly CryptoKeyType[] = ['ed25519'];
/** Types with a public half that can be exported as a JWKS. */
export const ASYMMETRIC_KEY_TYPES: readonly CryptoKeyType[] = ['x25519', 'ed25519'];

export function isCryptoKeyType(value: unknown): value is CryptoKeyType {
  return typeof value === 'string' && (CRYPTO_KEY_TYPES as readonly string[]).includes(value);
}

/** Every operation the server performs on a key. */
export const CRYPTO_OPERATIONS = [
  'encrypt',
  'decrypt',
  'rewrap',
  'datakey',
  'sign',
  'verify',
  'hmac',
] as const;
export type CryptoOperation = (typeof CRYPTO_OPERATIONS)[number];

/** Operations that are recorded in the audit trail, per key. */
export const CRYPTO_AUDIT_OPERATIONS = [
  ...CRYPTO_OPERATIONS,
  'public-key',
  'read',
  'create',
  'rotate',
  'policy',
  'delete',
  'export',
] as const;
export type CryptoAuditOperation = (typeof CRYPTO_AUDIT_OPERATIONS)[number];

/** What an operation needs on a specific key, e.g. `crypto:encrypt:orders`. */
export function cryptoScope(operation: CryptoOperation, key: string): string {
  return `crypto:${operation}:${key}`;
}

/** The capabilities that are not tied to one key. */
export const CRYPTO_SCOPES = {
  /** List keys, read a key's metadata and versions, read the audit trail. */
  keysRead: 'crypto:keys:read',
  /** Create, rotate, change policy and delete keys. */
  keysManage: 'crypto:keys:manage',
  /** Export an exportable key's material. */
  keysExport: 'crypto:keys:export',
} as const;

/** Every capability that gives full access to an operation on a key. `*` matches any segment(s). */
export const CRYPTO_WILDCARDS = ['crypto:*', 'crypto:encrypt:*', 'crypto:decrypt:*'] as const;

/**
 * Whether a token holding `granted` may do `required`. Segments are compared one by one; a `*`
 * matches one segment, and a trailing `*` matches every remaining segment. So `crypto:*` matches
 * everything, `crypto:encrypt:*` matches every key of `encrypt`, and `crypto:*:orders` matches
 * every operation on `orders` — but nothing is implied: a token with `crypto:encrypt:orders` cannot
 * decrypt, and a metadata capability never grants an operation.
 */
export function capabilityAllows(granted: readonly string[], required: string): boolean {
  const want = required.split(':');
  for (const capability of granted) {
    if (typeof capability !== 'string' || capability === '') continue;
    const have = capability.split(':');
    let matched = true;
    for (let index = 0; index < have.length; index += 1) {
      const segment = have[index];
      if (segment === '*') continue;
      if (index >= want.length || segment !== want[index]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A trailing `*` covers the rest; otherwise the shapes must have the same length.
    if (have.length === want.length || have[have.length - 1] === '*') return true;
  }
  return false;
}

/** The first of `required` the token does not hold, or `undefined` when it holds all of them. */
export function missingCapability(
  granted: readonly string[],
  required: readonly string[],
): string | undefined {
  return required.find((capability) => !capabilityAllows(granted, capability));
}

/** A key name: lowercase, one flat path segment, no `:` (it would break a capability). */
export const KEY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,62}$/;

export function isValidKeyName(value: unknown): value is string {
  return typeof value === 'string' && KEY_NAME_PATTERN.test(value);
}

export function assertKeyName(value: unknown): string {
  if (!isValidKeyName(value)) {
    throw new Error(
      `crypto: invalid key name ${JSON.stringify(value)} (lowercase letters, digits, "_" and "-", starting with a letter, at most 63 characters)`,
    );
  }
  return value;
}

/** An OKP public JWK (RFC 8037): the only shape a server ever publishes. */
export interface PublicJwk {
  kty: 'OKP';
  crv: 'X25519' | 'Ed25519';
  x: string;
  kid: string;
  use?: 'enc' | 'sig';
  alg?: 'EdDSA' | 'ECDH-ES';
}

export interface Jwks {
  keys: PublicJwk[];
}

/** One version of a key, as metadata. Never contains key material. */
export interface CryptoKeyVersionView {
  version: number;
  createdAt: string;
  createdBy: string;
  /** The kit key id: present on `x25519` and `ed25519`. */
  kid?: string;
  /** The public half: present on `x25519` and `ed25519`. */
  publicKey?: PublicJwk;
  /**
   * `latest` is what new writes use; `decryptable` is an older version still accepted down to
   * `minDecryptionVersion`; `retired` is below it and can no longer be used to decrypt.
   */
  status: 'latest' | 'decryptable' | 'retired';
}

/** A named key and its versions, as the console, the CLI and the dev tools list it. */
export interface CryptoKeyView {
  partition: string;
  name: string;
  type: CryptoKeyType;
  description?: string;
  latestVersion: number;
  minDecryptionVersion: number;
  deletionAllowed: boolean;
  exportable: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
  /** Set once the key was deleted; a deleted key no longer serves operations. */
  deletedAt?: string;
  versions: CryptoKeyVersionView[];
}

/** One row of the audit trail. Never contains plaintext or key material. */
export interface CryptoAuditRecord {
  id: string;
  at: string;
  partition: string;
  key?: string;
  version?: number;
  operation: CryptoAuditOperation;
  /** `actor ?? sub`: a person (via `act`), a service client, `cli:<user>`, `mcp:<id>`. */
  actor: string;
  clientId?: string;
  result: 'ok' | 'denied' | 'error';
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

/* -------------------------------------------------------------------------------------------- */
/* Requests and answers                                                                          */
/* -------------------------------------------------------------------------------------------- */

export interface EncryptInput {
  key: string;
  plaintext: string;
  /** Additional authenticated data: the same string must reach `decrypt`. */
  aad?: string;
  /** Encrypt with a specific version instead of the latest. Default: latest. */
  version?: number;
}

export interface EncryptResult {
  key: string;
  version: number;
  ciphertext: string;
}

export interface DecryptInput {
  key: string;
  ciphertext: string;
  aad?: string;
}

export interface DecryptResult {
  key: string;
  version: number;
  plaintext: string;
}

export interface RewrapInput {
  key: string;
  ciphertext: string;
  aad?: string;
}

export interface RewrapResult {
  key: string;
  version: number;
  ciphertext: string;
}

export interface DataKeyInput {
  /** The key that wraps the data key (an `aes256-gcm` key). */
  key: string;
  aad?: string;
  /** Return the plaintext data key too. Default `true`; `false` is the "wrapped only" mode. */
  plaintext?: boolean;
}

export interface DataKeyResult {
  key: string;
  version: number;
  /** The data key, base64url. Absent when `plaintext: false`. */
  plaintext?: string;
  /** The data key encrypted under the named key, base64url of the ciphertext. */
  wrapped: string;
}

export interface SignInput {
  key: string;
  /** The bytes to sign: utf8 text or base64url bytes. */
  message: string;
  encoding?: 'utf8' | 'base64url';
}

export interface SignResult {
  key: string;
  kid: string;
  signature: string;
}

export interface VerifyInput {
  key: string;
  message: string;
  signature: string;
  encoding?: 'utf8' | 'base64url';
}

export interface VerifyResult {
  key: string;
  valid: boolean;
}

export interface HmacInput {
  key: string;
  message: string;
  encoding?: 'utf8' | 'base64url';
}

export interface HmacResult {
  key: string;
  /** base64url HMAC-SHA256 of the message under the key's latest version. */
  hmac: string;
}

export interface PublicKeyResult {
  key: string;
  type: 'x25519' | 'ed25519';
  kid: string;
  jwk: PublicJwk;
  jwks: Jwks;
}

/** A batch call: answers in the same order as the inputs. */
export interface BatchResult<T> {
  results: T[];
}

export interface CreateKeyInput {
  name: string;
  type: CryptoKeyType;
  description?: string;
  /** Allow `delete` later. Default `false`: a key that could be deleted by accident is a bug. */
  deletionAllowed?: boolean;
  /** Allow `export` of the private material. Default `false`. */
  exportable?: boolean;
}

export interface KeyPolicyInput {
  description?: string | null;
  minDecryptionVersion?: number;
  deletionAllowed?: boolean;
  exportable?: boolean;
}

export interface ExportKeyResult {
  key: string;
  type: CryptoKeyType;
  version: number;
  /** The private key: base64url bytes for symmetric types, a private JWK for asymmetric ones. */
  material: string | Record<string, unknown>;
  kid?: string;
}

export interface Whoami {
  resource: string;
  partition: string;
  capabilities: string[];
  clientId?: string;
  expiresAt?: string;
}

/* -------------------------------------------------------------------------------------------- */
/* Errors and pages                                                                              */
/* -------------------------------------------------------------------------------------------- */

export type CryptoErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'unsupported'
  | 'unreadable'
  | 'deleted'
  | 'not_exportable'
  | 'too_large';

/** The body every crypto endpoint answers with on failure. */
export interface CryptoErrorBody {
  error: string;
  code: CryptoErrorCode;
}

const ERROR_STATUS: Record<CryptoErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid: 400,
  not_found: 404,
  conflict: 409,
  unsupported: 400,
  unreadable: 500,
  deleted: 410,
  not_exportable: 403,
  too_large: 413,
};

export function statusForErrorCode(code: CryptoErrorCode): number {
  return ERROR_STATUS[code] ?? 500;
}

/** An error the server, the client and the CLI all understand. */
export class CryptoError extends Error {
  readonly code: CryptoErrorCode;
  readonly status: number;
  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoError';
    this.code = code;
    this.status = statusForErrorCode(code);
  }
}

export interface OffsetMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

/** A page in the Agora list wire format (`_1x/LIST-API-SPEC.md`). */
export interface OffsetPage<T> {
  data: T[];
  meta: OffsetMeta;
}

/** The console's overview counters. */
export interface CryptoOverview {
  partition: string;
  keys: number;
  versions: number;
  operations24h: number;
  denied24h: number;
  errors24h: number;
  lastOperationAt?: string;
}
