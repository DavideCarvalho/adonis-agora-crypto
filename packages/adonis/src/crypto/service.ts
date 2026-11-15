import { createHmac, randomUUID } from 'node:crypto';
import {
  ASYMMETRIC_KEY_TYPES,
  type BatchResult,
  CRYPTO_AUDIT_OPERATIONS,
  type CreateKeyInput,
  type CryptoAuditOperation,
  type CryptoAuditRecord,
  CryptoError,
  type CryptoKeyType,
  type CryptoKeyVersionView,
  type CryptoKeyView,
  type CryptoOverview,
  capabilityAllows,
  cryptoScope,
  type DataKeyInput,
  type DataKeyResult,
  type DecryptInput,
  type DecryptResult,
  ENCRYPTION_KEY_TYPES,
  type EncryptInput,
  type EncryptResult,
  type ExportKeyResult,
  type HmacInput,
  type HmacResult,
  isValidKeyName,
  type KeyPolicyInput,
  type OffsetPage,
  type PublicKeyResult,
  type RewrapInput,
  type RewrapResult,
  SIGNING_KEY_TYPES,
  type SignInput,
  type SignResult,
  type VerifyInput,
  type VerifyResult,
  type Whoami,
} from '@adonis-agora/crypto-core';
import {
  type JwkSource,
  type Keyring,
  sign as kitSign,
  verify as kitVerify,
  openWith,
  sealedToKid,
  sealTo,
} from '../crypto-kit/index.js';
import type {
  AuditFilters,
  AuditPageQuery,
  CryptoKeyRecord,
  CryptoKeyVersionRecord,
  CryptoStore,
} from '../store/store.js';
import { openAead, readCiphertext, sealAead } from './ciphertext.js';
import {
  exportableMaterial,
  generateMaterial,
  type KeyMaterial,
  openMaterial,
  sealMaterial,
  symmetricKeyOf,
} from './material.js';

/** Who is asking: derived from a verified token, never from the request body. */
export interface CryptoPrincipal {
  /** The app (partition). The ONLY source of the app a call may touch. */
  partition: string;
  /** `crypto:encrypt:<key>`, `crypto:keys:read`, `crypto:*`, … */
  capabilities: string[];
  /** `actor ?? sub`: a person, a service client, `cli:<user>`, `mcp:<id>`. */
  actor: string;
  clientId?: string;
}

export interface CryptoServiceOptions {
  store: CryptoStore;
  /** The root keyring: what seals key material at rest. */
  keyring: Keyring;
  /** Clock, so tests can pin timestamps. */
  now?: () => string;
  /** Audit id, so tests can pin them. */
  id?: () => string;
  /** Batch ceiling. Default `100`. */
  maxBatchSize?: number;
}

export interface ListKeysQuery {
  page: number;
  size: number;
  search?: string;
  sort?: { field: 'name' | 'createdAt' | 'updatedAt'; direction: 'asc' | 'desc' };
}

export interface AuditListQuery {
  page: number;
  size: number;
  sort?: 'asc' | 'desc';
  filters?: AuditFilters;
}

const MAX_AAD = 512;
const MAX_PLAINTEXT = 64 * 1024;

function assertString(value: unknown, name: string): string {
  if (typeof value !== 'string')
    throw new CryptoError('invalid', `crypto: ${name} must be a string`);
  return value;
}

function assertAad(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new CryptoError('invalid', 'crypto: aad must be a string');
  if (value.length > MAX_AAD) {
    throw new CryptoError('invalid', `crypto: aad is longer than ${MAX_AAD} characters`);
  }
  return value;
}

function assertPlaintext(value: unknown): string {
  const text = assertString(value, 'plaintext');
  if (text.length > MAX_PLAINTEXT) {
    throw new CryptoError('too_large', `crypto: plaintext is longer than ${MAX_PLAINTEXT} bytes`);
  }
  return text;
}

function bytesOf(message: unknown, encoding: unknown): Buffer {
  const text = assertString(message, 'message');
  if (encoding === undefined || encoding === 'utf8') return Buffer.from(text, 'utf8');
  if (encoding !== 'base64url') {
    throw new CryptoError('invalid', "crypto: encoding must be 'utf8' or 'base64url'");
  }
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new CryptoError('invalid', 'crypto: message is not base64url');
  }
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) {
    throw new CryptoError('invalid', 'crypto: message is not canonical base64url');
  }
  return bytes;
}

function newAuditId(): string {
  return randomUUID();
}

/**
 * Every key and every operation of one crypto server. One implementation, three entry points —
 * HTTP, the console and the CLI — so validation, capability checks, audit and versioning are the
 * same everywhere. It never trusts its caller: every method takes the {@link CryptoPrincipal} and
 * checks the capability itself.
 */
export class CryptoService {
  readonly store: CryptoStore;
  readonly keyring: Keyring;
  readonly #now: () => string;
  readonly #id: () => string;
  readonly #maxBatch: number;

  constructor(options: CryptoServiceOptions) {
    this.store = options.store;
    this.keyring = options.keyring;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#id = options.id ?? newAuditId;
    this.#maxBatch = options.maxBatchSize ?? 100;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Audit                                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  async #audit(
    principal: CryptoPrincipal,
    entry: {
      operation: CryptoAuditOperation;
      key?: string | undefined;
      version?: number | undefined;
      result: CryptoAuditRecord['result'];
      error?: string | undefined;
      metadata?: Record<string, string | number | boolean> | undefined;
    },
  ): Promise<void> {
    await this.store.appendAudit({
      id: this.#id(),
      at: this.#now(),
      partition: principal.partition,
      operation: entry.operation,
      actor: principal.actor,
      result: entry.result,
      ...(entry.key !== undefined ? { key: entry.key } : {}),
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(principal.clientId !== undefined ? { clientId: principal.clientId } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
    });
  }

  /**
   * Runs one operation: refuses without the capability (and records the refusal), audits the
   * outcome, and only then returns. Key material and plaintext never reach the audit row.
   */
  async #perform<T>(
    principal: CryptoPrincipal,
    operation: CryptoAuditOperation | null,
    key: string | undefined,
    required: string | readonly string[],
    run: () => Promise<{ result: T; version?: number }>,
  ): Promise<T> {
    const capabilities = typeof required === 'string' ? [required] : required;
    const missing = capabilities.find(
      (capability) => !capabilityAllows(principal.capabilities, capability),
    );
    if (missing !== undefined) {
      if (operation !== null) {
        await this.#audit(principal, {
          operation,
          key,
          result: 'denied',
          error: `missing capability ${missing}`,
        });
      }
      throw new CryptoError('forbidden', `crypto: the token lacks ${missing}`);
    }
    try {
      const { result, version } = await run();
      if (operation !== null) {
        await this.#audit(principal, { operation, key, version, result: 'ok' });
      }
      return result;
    } catch (error) {
      if (operation !== null) {
        await this.#audit(principal, {
          operation,
          key,
          result: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    }
  }

  #assertPartition(principal: CryptoPrincipal): void {
    if (typeof principal.partition !== 'string' || principal.partition === '') {
      throw new CryptoError('unauthenticated', 'crypto: the token names no partition');
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Keys                                                                                        */
  /* ------------------------------------------------------------------------------------------ */

  #versionView(record: CryptoKeyRecord, version: CryptoKeyVersionRecord): CryptoKeyVersionView {
    const status =
      version.version === record.latestVersion
        ? 'latest'
        : version.version >= record.minDecryptionVersion
          ? 'decryptable'
          : 'retired';
    return {
      version: version.version,
      createdAt: version.createdAt,
      createdBy: version.createdBy,
      status,
      ...(version.kid !== undefined ? { kid: version.kid } : {}),
      ...(version.publicKey !== undefined ? { publicKey: version.publicKey } : {}),
    };
  }

  async #view(record: CryptoKeyRecord): Promise<CryptoKeyView> {
    const versions = await this.store.versions(record.partition, record.name);
    return {
      ...record,
      versions: versions.map((version) => this.#versionView(record, version)),
    };
  }

  async #keyRecord(principal: CryptoPrincipal, name: string): Promise<CryptoKeyRecord> {
    if (!isValidKeyName(name))
      throw new CryptoError('invalid', `crypto: invalid key name "${name}"`);
    const record = await this.store.getKey(principal.partition, name);
    if (!record) throw new CryptoError('not_found', `crypto: no key named "${name}"`);
    if (record.deletedAt !== undefined) {
      throw new CryptoError('deleted', `crypto: key "${name}" was deleted`);
    }
    return record;
  }

  /** The version to use: the one asked for, or the latest. Retired versions are refused. */
  async #versionFor(
    record: CryptoKeyRecord,
    requested: number | undefined,
  ): Promise<CryptoKeyVersionRecord> {
    const version = requested ?? record.latestVersion;
    if (!Number.isInteger(version) || version < 1) {
      throw new CryptoError('invalid', 'crypto: version must be a positive integer');
    }
    if (version > record.latestVersion) {
      throw new CryptoError('invalid', `crypto: "${record.name}" has no version ${version}`);
    }
    if (version < record.minDecryptionVersion) {
      throw new CryptoError(
        'invalid',
        `crypto: version ${version} of "${record.name}" is retired (minDecryptionVersion is ${record.minDecryptionVersion})`,
      );
    }
    const found = await this.store.version(record.partition, record.name, version);
    if (!found)
      throw new CryptoError('not_found', `crypto: "${record.name}" has no version ${version}`);
    return found;
  }

  async #material(record: CryptoKeyRecord, version: CryptoKeyVersionRecord): Promise<KeyMaterial> {
    return openMaterial(
      this.keyring,
      record.partition,
      record.name,
      version.version,
      record.type,
      version.sealed,
    );
  }

  #assertType(record: CryptoKeyRecord, allowed: readonly CryptoKeyType[], what: string): void {
    if (!allowed.includes(record.type)) {
      throw new CryptoError(
        'unsupported',
        `crypto: ${what} needs a ${allowed.join(' or ')} key ("${record.name}" is ${record.type})`,
      );
    }
  }

  async listKeys(
    principal: CryptoPrincipal,
    query: ListKeysQuery,
  ): Promise<OffsetPage<CryptoKeyView>> {
    this.#assertPartition(principal);
    return this.#perform(principal, null, undefined, 'crypto:keys:read', async () => {
      const records = await this.store.listKeys(principal.partition);
      const needle = query.search?.trim().toLowerCase();
      const matching = records.filter(
        (record) =>
          needle === undefined ||
          needle === '' ||
          record.name.toLowerCase().includes(needle) ||
          (record.description ?? '').toLowerCase().includes(needle),
      );
      const sort = query.sort ?? { field: 'name' as const, direction: 'asc' as const };
      const compare = (a: CryptoKeyRecord, b: CryptoKeyRecord) => {
        const left =
          sort.field === 'name'
            ? a.name
            : sort.field === 'createdAt'
              ? a.createdAt
              : (a.updatedAt ?? a.createdAt);
        const right =
          sort.field === 'name'
            ? b.name
            : sort.field === 'createdAt'
              ? b.createdAt
              : (b.updatedAt ?? b.createdAt);
        return sort.direction === 'asc' ? left.localeCompare(right) : right.localeCompare(left);
      };
      const sorted = [...matching].sort(compare);
      const start = (query.page - 1) * query.size;
      const data = await Promise.all(
        sorted.slice(start, start + query.size).map((r) => this.#view(r)),
      );
      const lastPage = Math.max(1, Math.ceil(sorted.length / query.size));
      return {
        result: {
          data,
          meta: {
            total: sorted.length,
            perPage: query.size,
            currentPage: query.page,
            lastPage,
            firstPage: 1,
          },
        },
      };
    });
  }

  async getKey(principal: CryptoPrincipal, name: string): Promise<CryptoKeyView> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'read', name, 'crypto:keys:read', async () => {
      if (!isValidKeyName(name)) {
        throw new CryptoError('invalid', `crypto: invalid key name "${name}"`);
      }
      const record = await this.store.getKey(principal.partition, name);
      if (!record) throw new CryptoError('not_found', `crypto: no key named "${name}"`);
      return { result: await this.#view(record) };
    });
  }

  async createKey(principal: CryptoPrincipal, input: CreateKeyInput): Promise<CryptoKeyView> {
    this.#assertPartition(principal);
    const name = input?.name;
    if (!isValidKeyName(name)) {
      throw new CryptoError(
        'invalid',
        `crypto: invalid key name ${JSON.stringify(name)} (lowercase letters, digits, "_" and "-", starting with a letter, at most 63 characters)`,
      );
    }
    return this.#perform(principal, 'create', name, 'crypto:keys:manage', async () => {
      if (
        !(
          input.type === 'aes256-gcm' ||
          input.type === 'x25519' ||
          input.type === 'ed25519' ||
          input.type === 'hmac-sha256'
        )
      ) {
        throw new CryptoError('invalid', `crypto: unknown key type "${input.type}"`);
      }
      const existing = await this.store.getKey(principal.partition, name);
      if (existing) {
        throw new CryptoError(
          'conflict',
          existing.deletedAt
            ? `crypto: the name "${name}" belonged to a deleted key; choose another name`
            : `crypto: key "${name}" already exists`,
        );
      }
      const now = this.#now();
      const material = generateMaterial(input.type);
      const sealed = await sealMaterial(this.keyring, principal.partition, name, 1, material);
      const record: CryptoKeyRecord = {
        partition: principal.partition,
        name,
        type: input.type,
        ...(input.description !== undefined ? { description: input.description } : {}),
        latestVersion: 1,
        minDecryptionVersion: 1,
        deletionAllowed: input.deletionAllowed ?? false,
        exportable: input.exportable ?? false,
        createdAt: now,
        createdBy: principal.actor,
      };
      await this.store.createKey(record, {
        partition: principal.partition,
        name,
        version: 1,
        sealed: sealed.sealed,
        ...(sealed.kid !== undefined ? { kid: sealed.kid } : {}),
        ...(sealed.publicKey !== undefined ? { publicKey: sealed.publicKey } : {}),
        createdAt: now,
        createdBy: principal.actor,
      });
      return { result: await this.#view(record), version: 1 };
    });
  }

  async rotateKey(principal: CryptoPrincipal, name: string): Promise<CryptoKeyView> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'rotate', name, 'crypto:keys:manage', async () => {
      const record = await this.#keyRecord(principal, name);
      const nextVersion = record.latestVersion + 1;
      const material = generateMaterial(record.type);
      const sealed = await sealMaterial(
        this.keyring,
        principal.partition,
        name,
        nextVersion,
        material,
      );
      const now = this.#now();
      await this.store.addVersion(
        {
          partition: principal.partition,
          name,
          version: nextVersion,
          sealed: sealed.sealed,
          ...(sealed.kid !== undefined ? { kid: sealed.kid } : {}),
          ...(sealed.publicKey !== undefined ? { publicKey: sealed.publicKey } : {}),
          createdAt: now,
          createdBy: principal.actor,
        },
        { latestVersion: nextVersion, updatedAt: now, updatedBy: principal.actor },
      );
      const updated = await this.store.getKey(principal.partition, name);
      return {
        result: await this.#view(updated ?? { ...record, latestVersion: nextVersion }),
        version: nextVersion,
      };
    });
  }

  async updateKeyPolicy(
    principal: CryptoPrincipal,
    name: string,
    input: KeyPolicyInput,
  ): Promise<CryptoKeyView> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'policy', name, 'crypto:keys:manage', async () => {
      const record = await this.#keyRecord(principal, name);
      const min = input.minDecryptionVersion;
      if (min !== undefined && (!Number.isInteger(min) || min < 1 || min > record.latestVersion)) {
        throw new CryptoError(
          'invalid',
          `crypto: minDecryptionVersion must be between 1 and ${record.latestVersion}`,
        );
      }
      if (input.description !== undefined && input.description !== null) {
        if (typeof input.description !== 'string') {
          throw new CryptoError('invalid', 'crypto: description must be a string or null');
        }
      }
      await this.store.updateKey(principal.partition, name, {
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(min !== undefined ? { minDecryptionVersion: min } : {}),
        ...(input.deletionAllowed !== undefined ? { deletionAllowed: input.deletionAllowed } : {}),
        ...(input.exportable !== undefined ? { exportable: input.exportable } : {}),
        updatedAt: this.#now(),
        updatedBy: principal.actor,
      });
      const updated = await this.store.getKey(principal.partition, name);
      return { result: await this.#view(updated ?? record) };
    });
  }

  async deleteKey(
    principal: CryptoPrincipal,
    name: string,
  ): Promise<{ key: string; deleted: boolean }> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'delete', name, 'crypto:keys:manage', async () => {
      const record = await this.#keyRecord(principal, name);
      if (!record.deletionAllowed) {
        throw new CryptoError(
          'forbidden',
          `crypto: "${name}" does not allow deletion (set deletionAllowed first)`,
        );
      }
      await this.store.deleteKey(principal.partition, name, this.#now(), principal.actor);
      return { result: { key: name, deleted: true }, version: record.latestVersion };
    });
  }

  async exportKey(
    principal: CryptoPrincipal,
    name: string,
    version?: number,
  ): Promise<ExportKeyResult> {
    this.#assertPartition(principal);
    return this.#perform(
      principal,
      'export',
      name,
      ['crypto:keys:export', cryptoScope('decrypt', name)],
      async () => {
        const record = await this.#keyRecord(principal, name);
        if (!record.exportable) {
          throw new CryptoError(
            'not_exportable',
            `crypto: "${name}" is not exportable (set exportable first)`,
          );
        }
        const chosen = await this.#versionFor(record, version);
        const material = await this.#material(record, chosen);
        const exported = exportableMaterial(material);
        return {
          result: {
            key: name,
            type: record.type,
            version: chosen.version,
            material: exported.material,
            ...(exported.kid !== undefined ? { kid: exported.kid } : {}),
          },
          version: chosen.version,
        };
      },
    );
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Operations                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  async encrypt(principal: CryptoPrincipal, input: EncryptInput): Promise<EncryptResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(principal, 'encrypt', name, cryptoScope('encrypt', name), async () => {
      const record = await this.#keyRecord(principal, name);
      this.#assertType(record, ENCRYPTION_KEY_TYPES, 'encrypt');
      const plaintext = assertPlaintext(input.plaintext);
      const aad = assertAad(input.aad);
      const chosen = await this.#versionFor(record, input.version);
      const material = await this.#material(record, chosen);
      if (record.type === 'x25519') {
        if (material.kind !== 'x25519') {
          throw new CryptoError('unreadable', `crypto: "${name}" is not an X25519 key`);
        }
        return {
          result: {
            key: name,
            version: chosen.version,
            ciphertext: sealTo(material.publicKey, plaintext, {
              ...(aad !== undefined ? { aad } : {}),
            }),
          },
          version: chosen.version,
        };
      }
      if (material.kind !== 'aes256-gcm') {
        throw new CryptoError('unreadable', `crypto: "${name}" is not an AES-256-GCM key`);
      }
      return {
        result: {
          key: name,
          version: chosen.version,
          ciphertext: sealAead(material.key, plaintext, {
            key: name,
            version: chosen.version,
            ...(aad !== undefined ? { aad } : {}),
          }),
        },
        version: chosen.version,
      };
    });
  }

  async #open(
    principal: CryptoPrincipal,
    input: { key: string; ciphertext: string; aad?: string | undefined },
  ): Promise<{ record: CryptoKeyRecord; version: CryptoKeyVersionRecord; plaintext: string }> {
    const record = await this.#keyRecord(principal, input.key);
    this.#assertType(record, ENCRYPTION_KEY_TYPES, 'decrypt');
    const ciphertext = assertString(input.ciphertext, 'ciphertext');
    const aad = assertAad(input.aad);
    let versionNumber: number | undefined;
    if (record.type === 'x25519') {
      const kid = sealedToKid(ciphertext);
      if (kid === undefined) {
        throw new CryptoError('invalid', 'crypto: not an agora:pk1 ciphertext');
      }
      const versions = await this.store.versions(record.partition, record.name);
      const found = versions.find((entry) => entry.kid === kid);
      if (!found) {
        throw new CryptoError(
          'not_found',
          `crypto: "${record.name}" has no version with kid "${kid}"`,
        );
      }
      versionNumber = found.version;
    } else {
      const parsed = readCiphertext(ciphertext);
      if (!parsed) throw new CryptoError('invalid', 'crypto: not an agora:ct1 ciphertext');
      if (parsed.key !== record.name) {
        throw new CryptoError('invalid', `crypto: the ciphertext belongs to key "${parsed.key}"`);
      }
      versionNumber = parsed.version;
    }
    if (versionNumber < record.minDecryptionVersion) {
      throw new CryptoError(
        'invalid',
        `crypto: version ${versionNumber} of "${record.name}" is retired (minDecryptionVersion is ${record.minDecryptionVersion})`,
      );
    }
    const version = await this.store.version(record.partition, record.name, versionNumber);
    if (!version) {
      throw new CryptoError(
        'not_found',
        `crypto: "${record.name}" has no version ${versionNumber}`,
      );
    }
    const material = await this.#material(record, version);
    if (material.kind === 'x25519') {
      try {
        const plaintext = openWith(material.privateKey as JwkSource, ciphertext, {
          ...(aad !== undefined ? { aad } : {}),
        });
        return { record, version, plaintext };
      } catch {
        throw new CryptoError(
          'invalid',
          'crypto: the ciphertext did not open (tampered, or the wrong aad)',
        );
      }
    }
    if (material.kind !== 'aes256-gcm') {
      throw new CryptoError('unreadable', `crypto: "${record.name}" is not an AES-256-GCM key`);
    }
    return {
      record,
      version,
      plaintext: openAead(material.key, ciphertext, {
        key: record.name,
        version: versionNumber,
        ...(aad !== undefined ? { aad } : {}),
      }),
    };
  }

  async decrypt(principal: CryptoPrincipal, input: DecryptInput): Promise<DecryptResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(principal, 'decrypt', name, cryptoScope('decrypt', name), async () => {
      const opened = await this.#open(principal, { ...input, key: name });
      return {
        result: { key: name, version: opened.version.version, plaintext: opened.plaintext },
        version: opened.version.version,
      };
    });
  }

  async rewrap(principal: CryptoPrincipal, input: RewrapInput): Promise<RewrapResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(
      principal,
      'rewrap',
      name,
      [cryptoScope('rewrap', name), cryptoScope('encrypt', name), cryptoScope('decrypt', name)],
      async () => {
        const opened = await this.#open(principal, { ...input, key: name });
        const plaintext = opened.plaintext;
        const latest = await this.#versionFor(opened.record, undefined);
        const material = await this.#material(opened.record, latest);
        const aad = assertAad(input.aad);
        let ciphertext: string;
        if (material.kind === 'x25519') {
          ciphertext = sealTo(material.publicKey, plaintext, {
            ...(aad !== undefined ? { aad } : {}),
          });
        } else if (material.kind === 'aes256-gcm') {
          ciphertext = sealAead(material.key, plaintext, {
            key: name,
            version: latest.version,
            ...(aad !== undefined ? { aad } : {}),
          });
        } else {
          throw new CryptoError('unreadable', `crypto: "${name}" is not an encryption key`);
        }
        // The plaintext existed in memory for the length of this call and is never returned.
        return {
          result: { key: name, version: latest.version, ciphertext },
          version: latest.version,
        };
      },
    );
  }

  async generateDataKey(principal: CryptoPrincipal, input: DataKeyInput): Promise<DataKeyResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(
      principal,
      'datakey',
      name,
      [cryptoScope('datakey', name), cryptoScope('encrypt', name), cryptoScope('decrypt', name)],
      async () => {
        const record = await this.#keyRecord(principal, name);
        this.#assertType(record, ['aes256-gcm'], 'a data key');
        const chosen = await this.#versionFor(record, undefined);
        const material = await this.#material(record, chosen);
        const dataKey = generateMaterial('aes256-gcm');
        if (dataKey.kind !== 'aes256-gcm') {
          throw new CryptoError('unreadable', 'crypto: could not generate a data key');
        }
        if (material.kind !== 'aes256-gcm') {
          throw new CryptoError('unreadable', `crypto: "${name}" is not an AES-256-GCM key`);
        }
        const aad = assertAad(input.aad);
        const wrapped = sealAead(material.key, dataKey.key, {
          key: name,
          version: chosen.version,
          ...(aad !== undefined ? { aad } : {}),
        });
        return {
          result: {
            key: name,
            version: chosen.version,
            ...(input.plaintext === false ? {} : { plaintext: dataKey.key }),
            wrapped,
          },
          version: chosen.version,
        };
      },
    );
  }

  async sign(principal: CryptoPrincipal, input: SignInput): Promise<SignResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(principal, 'sign', name, cryptoScope('sign', name), async () => {
      const record = await this.#keyRecord(principal, name);
      this.#assertType(record, SIGNING_KEY_TYPES, 'sign');
      const bytes = bytesOf(input.message, input.encoding);
      const chosen = await this.#versionFor(record, undefined);
      const material = await this.#material(record, chosen);
      if (material.kind !== 'ed25519') {
        throw new CryptoError('unreadable', `crypto: "${name}" is not an Ed25519 key`);
      }
      return {
        result: {
          key: name,
          kid: material.privateKey.kid,
          signature: kitSign(material.privateKey, bytes),
        },
        version: chosen.version,
      };
    });
  }

  async verify(principal: CryptoPrincipal, input: VerifyInput): Promise<VerifyResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(principal, 'verify', name, cryptoScope('verify', name), async () => {
      const record = await this.#keyRecord(principal, name);
      this.#assertType(record, SIGNING_KEY_TYPES, 'verify');
      const bytes = bytesOf(input.message, input.encoding);
      const signature = assertString(input.signature, 'signature');
      const versions = await this.store.versions(record.partition, record.name);
      const keys = versions
        .map((version) => version.publicKey)
        .filter((key): key is NonNullable<typeof key> => key !== undefined);
      // Verification accepts every version's public key: rotation must not invalidate signatures
      // made before it.
      return { result: { key: name, valid: kitVerify(keys, bytes, signature) } };
    });
  }

  async hmac(principal: CryptoPrincipal, input: HmacInput): Promise<HmacResult> {
    this.#assertPartition(principal);
    const name = assertString(input?.key, 'key');
    return this.#perform(principal, 'hmac', name, cryptoScope('hmac', name), async () => {
      const record = await this.#keyRecord(principal, name);
      this.#assertType(record, ['hmac-sha256'], 'hmac');
      const chosen = await this.#versionFor(record, undefined);
      const material = await this.#material(record, chosen);
      const digest = createHmac('sha256', symmetricKeyOf(material))
        .update(bytesOf(input.message, input.encoding))
        .digest('base64url');
      return { result: { key: name, hmac: digest }, version: chosen.version };
    });
  }

  async publicKey(principal: CryptoPrincipal, name: string): Promise<PublicKeyResult> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'public-key', name, 'crypto:keys:read', async () => {
      const record = await this.#keyRecord(principal, name);
      if (!ASYMMETRIC_KEY_TYPES.includes(record.type)) {
        throw new CryptoError(
          'unsupported',
          `crypto: "${name}" is ${record.type} and has no public key`,
        );
      }
      const chosen = await this.#versionFor(record, undefined);
      if (!chosen.publicKey) {
        throw new CryptoError('unreadable', `crypto: "${name}" has no public key on record`);
      }
      return { result: this.#publicView(record, chosen) };
    });
  }

  async jwks(
    principal: CryptoPrincipal,
    name: string,
  ): Promise<{ keys: PublicKeyResult['jwk'][] }> {
    this.#assertPartition(principal);
    return this.#perform(principal, 'public-key', name, 'crypto:keys:read', async () => {
      const record = await this.#keyRecord(principal, name);
      if (!ASYMMETRIC_KEY_TYPES.includes(record.type)) {
        throw new CryptoError(
          'unsupported',
          `crypto: "${name}" is ${record.type} and has no public keys`,
        );
      }
      const versions = await this.store.versions(record.partition, record.name);
      return {
        result: {
          keys: versions
            .map((version) => version.publicKey)
            .filter((key): key is NonNullable<typeof key> => key !== undefined)
            .reverse(),
        },
      };
    });
  }

  #publicView(record: CryptoKeyRecord, version: CryptoKeyVersionRecord): PublicKeyResult {
    const jwk = version.publicKey;
    if (!jwk || !version.kid) {
      throw new CryptoError('unreadable', `crypto: "${record.name}" has no public key on record`);
    }
    return {
      key: record.name,
      type: record.type as 'x25519' | 'ed25519',
      kid: version.kid,
      jwk,
      jwks: { keys: [jwk] },
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Batches                                                                                     */
  /* ------------------------------------------------------------------------------------------ */

  #batch<T>(items: unknown): readonly T[] {
    if (!Array.isArray(items)) throw new CryptoError('invalid', 'crypto: items must be an array');
    if (items.length > this.#maxBatch) {
      throw new CryptoError('too_large', `crypto: a batch holds at most ${this.#maxBatch} items`);
    }
    return items as readonly T[];
  }

  async #runBatch<I, O>(
    items: readonly I[],
    run: (item: I, index: number) => Promise<O>,
  ): Promise<BatchResult<O>> {
    const results: O[] = [];
    for (let index = 0; index < items.length; index += 1) {
      try {
        results.push(await run(items[index] as I, index));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new CryptoError(
          error instanceof CryptoError ? error.code : 'invalid',
          `crypto: batch item ${index} failed: ${message}`,
        );
      }
    }
    return { results };
  }

  async encryptBatch(
    principal: CryptoPrincipal,
    items: unknown,
  ): Promise<BatchResult<EncryptResult>> {
    return this.#runBatch(this.#batch<EncryptInput>(items), (item) =>
      this.encrypt(principal, item),
    );
  }

  async decryptBatch(
    principal: CryptoPrincipal,
    items: unknown,
  ): Promise<BatchResult<DecryptResult>> {
    return this.#runBatch(this.#batch<DecryptInput>(items), (item) =>
      this.decrypt(principal, item),
    );
  }

  async signBatch(principal: CryptoPrincipal, items: unknown): Promise<BatchResult<SignResult>> {
    return this.#runBatch(this.#batch<SignInput>(items), (item) => this.sign(principal, item));
  }

  async verifyBatch(
    principal: CryptoPrincipal,
    items: unknown,
  ): Promise<BatchResult<VerifyResult>> {
    return this.#runBatch(this.#batch<VerifyInput>(items), (item) => this.verify(principal, item));
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Audit, overview, identity                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  async audit(
    principal: CryptoPrincipal,
    query: AuditListQuery,
  ): Promise<OffsetPage<CryptoAuditRecord>> {
    this.#assertPartition(principal);
    return this.#perform(principal, null, undefined, 'crypto:keys:read', async () => ({
      result: await this.store.listAudit(principal.partition, {
        page: query.page,
        size: query.size,
        ...(query.sort !== undefined ? { sort: query.sort } : {}),
        ...(query.filters !== undefined ? { filters: query.filters } : {}),
      } satisfies AuditPageQuery),
    }));
  }

  async overview(principal: CryptoPrincipal): Promise<CryptoOverview> {
    this.#assertPartition(principal);
    return this.#perform(principal, null, undefined, 'crypto:keys:read', async () => {
      const keys = await this.store.listKeys(principal.partition);
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const counts = await this.store.auditCounts(principal.partition, since);
      let versions = 0;
      for (const key of keys) {
        versions += (await this.store.versions(key.partition, key.name)).length;
      }
      return {
        result: {
          partition: principal.partition,
          keys: keys.filter((key) => key.deletedAt === undefined).length,
          versions,
          operations24h: counts.operations,
          denied24h: counts.denied,
          errors24h: counts.errors,
          ...(counts.lastAt !== undefined ? { lastOperationAt: counts.lastAt } : {}),
        },
      };
    });
  }

  whoami(principal: CryptoPrincipal): Whoami {
    this.#assertPartition(principal);
    return {
      resource: 'urn:agora:crypto',
      partition: principal.partition,
      capabilities: [...principal.capabilities],
      ...(principal.clientId !== undefined ? { clientId: principal.clientId } : {}),
    };
  }
}

/** The audit operations the service knows, exported for the console's filters. */
export const KNOWN_AUDIT_OPERATIONS: readonly CryptoAuditOperation[] = CRYPTO_AUDIT_OPERATIONS;
