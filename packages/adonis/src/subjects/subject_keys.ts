import { isValidKeyName } from '@adonis-agora/crypto-core';
import { readCiphertext } from '../crypto/ciphertext.js';
import { emitCrypto, errorCodeOf } from '../diagnostics.js';
import { type CachedDataKey, DataKeyCache, type DataKeyCacheOptions } from './cache.js';
import {
  newDataKeyId,
  openWithDataKey,
  readSubjectCiphertext,
  sealWithDataKey,
} from './ciphertext.js';
import { fromControlPlane, SubjectKeyError } from './errors.js';
import type { DataKeyRecord, DataKeyStore } from './store.js';

/** A subject id: whoever owns the data (a researcher, a user, a tenant). */
export type SubjectId = string | number;

/**
 * A subject, optionally typed: `{ type: 'researcher', id: 7 }` and `{ type: 'project', id: 7 }` get
 * different keys (`subject_researcher_7`, `subject_project_7`), where a bare `7` would share one.
 * Types are lowercase letters, digits and `-` (no `_`, so names cannot collide).
 */
export type SubjectRef = SubjectId | { type: string; id: SubjectId };

const SUBJECT_TYPE = /^[a-z][a-z0-9-]{0,30}$/;

/** The slice of the crypto operations subject keys use (in process, over HTTP or a broker). */
export interface SubjectKeyOperations {
  generateDataKey(input: {
    key: string;
    aad?: string;
    context?: string;
  }): Promise<{ key: string; version: number; plaintext?: string; wrapped: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
  rewrap(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ version: number; ciphertext: string }>;
  createKey(input: {
    name: string;
    type: 'aes256-gcm';
    description?: string;
    deletionAllowed?: boolean;
  }): Promise<unknown>;
  deleteKey(name: string): Promise<unknown>;
  getKey(name: string): Promise<{ latestVersion: number; deletedAt?: string }>;
}

export interface SubjectKeysOptions {
  operations: SubjectKeyOperations;
  store: DataKeyStore;
  /** The unwrapped-data-key cache: options, or `false` to call the control plane every time. */
  cache?: DataKeyCacheOptions | false;
  /** Key name of a subject: `${prefix}${id}`, or `${prefix}${type}_${id}`. Default prefix `subject_`. */
  prefix?: string;
  /** Full control over the key name (must match `^[a-z][a-z0-9_-]{0,62}$`). Overrides `prefix`. */
  keyName?: (id: SubjectId, type: string | undefined) => string;
  /**
   * Refuse bare ids: every subject must be `{ type, id }` (or come from a column `namespace`), so
   * researcher 7 and project 7 never share a key. Default `true`; `false` allows bare ids (one kind
   * of subject only), and even then a bare string id containing `_` is refused, so it can never name
   * a typed subject's key.
   */
  requireType?: boolean;
  /**
   * `lazy` (default) creates a subject's key on its first write; `explicit` refuses to write until
   * `subjects.create(id)` ran (a typo in a subject id then fails instead of creating a key).
   */
  createKeys?: 'lazy' | 'explicit';
  /** Clock, so tests can pin timestamps. */
  now?: () => string;
  /** This app's partition, stamped as `app` on the diagnostics events subject keys publish. */
  app?: string;
}

export interface SealOptions {
  /** Additional authenticated data: the same string must reach `decrypt`. */
  aad?: string | undefined;
}

export interface OpenOptions extends SealOptions {
  /** The subject the ciphertext must belong to. Required unless `anySubject: true`. */
  subject?: SubjectRef;
  /**
   * Open a ciphertext of whichever subject it names. Only safe when something else (the `aad`)
   * already binds the value to its owner.
   */
  anySubject?: boolean;
}

export interface RewrapDataKeysResult {
  scanned: number;
  rewrapped: number;
  /** Data keys of a forgotten subject (left as they are; they cannot be opened anyway). */
  forgotten: number;
}

/** The AAD a data key is wrapped with: a wrapped key copied onto another row does not open. */
const dataKeyAad = (id: string) => `agora:dek:${id}`;

const AUDIT_CONTEXT = 'subject-keys';

/**
 * Per-subject encryption with local envelopes.
 *
 * Each subject has a key-encryption key on the control plane (`subject_<id>`, an `aes256-gcm` key
 * that allows deletion). Values are sealed **in this process** with AES-256-GCM under a data key; the
 * data key is wrapped by the subject key on the control plane and the wrapped form is stored in the
 * app's database (`crypto_data_keys`). Unwrapped data keys are cached in memory (LRU + TTL), so
 * steady-state reads and writes make no network call.
 *
 * Deleting the subject key (`forget`) makes every wrapped data key — and so every value — of that
 * subject unrecoverable (crypto-shredding).
 */
export class SubjectKeys {
  readonly cache: DataKeyCache;
  readonly store: DataKeyStore;
  readonly #operations: SubjectKeyOperations;
  readonly #prefix: string;
  readonly #keyName: ((id: SubjectId, type: string | undefined) => string) | undefined;
  readonly #requireType: boolean;
  readonly #lazy: boolean;
  /** Subject keys forgotten by this process: never cached again, never asked for again. */
  readonly #forgotten = new Set<string>();
  /** Bumped by `rotateDataKey` and `forget`: an in-flight provision older than this is stale. */
  readonly #epochs = new Map<string, number>();
  /** Rotations in flight: a cold write waits for them instead of picking the old data key. */
  readonly #rotating = new Map<string, Promise<unknown>>();
  readonly #now: () => string;
  readonly #app: string | undefined;
  /** In-flight work, so concurrent callers share one round trip. */
  readonly #unwrapping = new Map<string, Promise<void>>();
  readonly #provisioning = new Map<string, Promise<string>>();

  constructor(options: SubjectKeysOptions) {
    this.#operations = options.operations;
    this.store = options.store;
    this.cache = new DataKeyCache(
      options.cache === false ? { maxEntries: 0, ttlMs: 0 } : (options.cache ?? {}),
    );
    this.#prefix = options.prefix ?? 'subject_';
    this.#keyName = options.keyName;
    this.#requireType = options.requireType !== false;
    this.#lazy = (options.createKeys ?? 'lazy') === 'lazy';
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#app = options.app === '' ? undefined : options.app;
  }

  /**
   * `subjects.cache`: a data key this process had to fetch from the control plane. Only misses are
   * reported: a hit happens on every read and write and would flood the recorders.
   */
  #reportMiss(key: string, op: 'encrypt' | 'decrypt'): void {
    const app = this.#app;
    emitCrypto(
      'subjects.cache',
      () => ({ ...(app !== undefined ? { app } : {}), key, op, outcome: 'miss' }),
      { app },
    );
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Subjects                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  /** The key prefix (`subject_` by default). */
  get prefix(): string {
    return this.#prefix;
  }

  /** Whether key names come from a custom `keyName` function. */
  get hasCustomKeyName(): boolean {
    return this.#keyName !== undefined;
  }

  /** Whether bare subject ids are refused (`requireType`). */
  get requiresType(): boolean {
    return this.#requireType;
  }

  /** The control-plane key name of a subject. Throws `invalid` for an id that cannot be one. */
  keyName(subject: SubjectRef): string {
    let type: string | undefined;
    let id: unknown = subject;
    if (subject !== null && typeof subject === 'object') {
      type = (subject as { type?: unknown }).type as string | undefined;
      id = (subject as { id?: unknown }).id;
      if (typeof type !== 'string' || !SUBJECT_TYPE.test(type)) {
        throw new SubjectKeyError(
          'invalid',
          `crypto: subject type ${JSON.stringify(type)} must be lowercase letters, digits and "-"`,
        );
      }
    } else if (this.#requireType) {
      throw new SubjectKeyError(
        'invalid',
        'crypto: subjects must be typed ({ type, id }) because `requireType` is on',
      );
    }
    if (id === null || id === undefined || id === '') {
      throw new SubjectKeyError('invalid', 'crypto: a subject id is required');
    }
    if (typeof id !== 'string' && typeof id !== 'number') {
      throw new SubjectKeyError('invalid', 'crypto: a subject id is a string or a number');
    }
    if (type === undefined && typeof id === 'string' && id.includes('_')) {
      // `researcher_7` would be the key of { type: 'researcher', id: 7 }.
      throw new SubjectKeyError(
        'invalid',
        'crypto: a bare subject id cannot contain "_" (it could name a typed subject’s key); use { type, id }',
      );
    }
    const name = this.#keyName
      ? this.#keyName(id, type)
      : `${this.#prefix}${type !== undefined ? `${type}_` : ''}${String(id)}`;
    if (!isValidKeyName(name)) {
      throw new SubjectKeyError(
        'invalid',
        `crypto: subject ${JSON.stringify(subject)} gives the key name ${JSON.stringify(name)}, which is not a valid key name (lowercase letters, digits, "_" and "-", at most 63 characters)`,
      );
    }
    return name;
  }

  /** Creates the subject's key now. Idempotent: `created: false` when it already existed. */
  async create(subject: SubjectRef): Promise<{ key: string; created: boolean }> {
    const key = this.keyName(subject);
    return { key, created: await this.#createKey(key) };
  }

  /**
   * Crypto-shredding: deletes the subject's key on the control plane, then its wrapped data keys
   * and its cached data keys here. Every value sealed for the subject is unrecoverable afterwards.
   * A subject that never had a key gets one created and deleted, so the id stays forgotten.
   *
   * Other processes that still cache one of its data keys keep it until the cache TTL runs out;
   * call `evict(subject)` there (from your own event bus) to cut that window.
   */
  async forget(subject: SubjectRef): Promise<{ key: string; forgotten: true; dataKeys: number }> {
    const key = this.keyName(subject);
    const started = performance.now();
    const app = this.#app;
    const report = (outcome: { dataKeys: number } | { error: unknown }) => {
      const durationMs = performance.now() - started;
      emitCrypto(
        'subjects.forget',
        () => ({
          ...(app !== undefined ? { app } : {}),
          key,
          ...('error' in outcome
            ? { outcome: 'error' as const, errorCode: errorCodeOf(outcome.error) }
            : { outcome: 'ok' as const, dataKeys: outcome.dataKeys }),
          durationMs,
        }),
        { app, durationMs },
      );
    };
    try {
      const result = await this.#forget(key);
      report({ dataKeys: result.dataKeys });
      return result;
    } catch (error) {
      report({ error });
      throw error;
    }
  }

  async #forget(key: string): Promise<{ key: string; forgotten: true; dataKeys: number }> {
    try {
      await this.#operations.deleteKey(key);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'not_found') {
        await this.#createKey(key);
        await this.#operations.deleteKey(key).catch((again: unknown) => {
          throw fromControlPlane(again, `forget ${key}`);
        });
      } else if (code !== 'deleted') {
        throw fromControlPlane(error, `forget ${key}`);
      }
    }
    // Tombstone first: a provision already in flight cannot cache this subject's data key again.
    this.#forgotten.add(key);
    this.#bump(key);
    this.#provisioning.delete(key);
    this.cache.evictKey(key);
    const dataKeys = await this.store.deleteKey(key);
    this.cache.evictKey(key);
    return { key, forgotten: true, dataKeys };
  }

  /**
   * Loads the subject's current data key into the cache (creating the key and the data key when
   * needed), so the next writes and reads need neither the crypto server nor the data-key table.
   */
  async warm(subject: SubjectRef): Promise<{ key: string; dataKeyId: string }> {
    const key = this.keyName(subject);
    const { id, bytes } = await this.#currentDataKey(key);
    bytes.fill(0);
    return { key, dataKeyId: id };
  }

  /** Drops (and zeroes) this process' cached data keys of a subject. */
  evict(subject: SubjectRef): void {
    this.cache.evictKey(this.keyName(subject));
  }

  /** Drops (and zeroes) every cached data key. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Starts a new data key for a subject's writes. Values sealed with the old one keep opening;
   * `crypto:subjects:backfill --rotate` re-encrypts them. Other processes switch once their cached
   * current data key expires.
   */
  async rotateDataKey(subject: SubjectRef): Promise<{ key: string; retired: number }> {
    const key = this.keyName(subject);
    this.#bump(key);
    this.#provisioning.delete(key);
    this.cache.forgetCurrent(key);
    const retiring = this.store.retire(key, this.#now());
    this.#rotating.set(key, retiring);
    let retired: number;
    try {
      retired = await retiring;
    } finally {
      if (this.#rotating.get(key) === retiring) this.#rotating.delete(key);
    }
    // Again once the retirement is visible: a provision that started while it was in flight read
    // the old data key as current, and must neither stay cached as current nor be handed out.
    this.#bump(key);
    this.#provisioning.delete(key);
    this.cache.forgetCurrent(key);
    return { key, retired };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Values                                                                                      */
  /* ------------------------------------------------------------------------------------------ */

  /** Seals a string for a subject: `agora:se1:<key>:<data key id>:…`. */
  async encrypt(
    subject: SubjectRef,
    plaintext: string,
    options: SealOptions = {},
  ): Promise<string> {
    if (typeof plaintext !== 'string') {
      throw new SubjectKeyError('invalid', 'crypto: plaintext must be a string');
    }
    const key = this.keyName(subject);
    const { id, bytes } = await this.#currentDataKey(key, 'encrypt');
    try {
      return sealWithDataKey(bytes, plaintext, { key, dataKeyId: id, aad: options.aad });
    } finally {
      bytes.fill(0);
    }
  }

  /** Opens a subject ciphertext. Throws a {@link SubjectKeyError}; never returns the ciphertext. */
  async decrypt(ciphertext: string, options: OpenOptions = {}): Promise<string> {
    const parsed = readSubjectCiphertext(ciphertext);
    if (!parsed) throw new SubjectKeyError('invalid', 'crypto: not an agora:se1 ciphertext');
    if (options.subject !== undefined) {
      if (this.keyName(options.subject) !== parsed.key) {
        throw new SubjectKeyError('invalid', 'crypto: the ciphertext belongs to another subject');
      }
    } else if (options.anySubject !== true) {
      throw new SubjectKeyError(
        'invalid',
        'crypto: decrypt needs the expected `subject` (or `anySubject: true` when the aad already binds the owner)',
      );
    }
    const bytes = await this.#dataKey(parsed.dataKeyId, parsed.key, 'decrypt');
    try {
      return openWithDataKey(bytes, ciphertext, { ...parsed, aad: options.aad });
    } finally {
      bytes.fill(0);
    }
  }

  /** `encrypt(subject, JSON.stringify(value))`. */
  encryptJson(subject: SubjectRef, value: unknown, options: SealOptions = {}): Promise<string> {
    const text = JSON.stringify(value);
    if (text === undefined) {
      throw new SubjectKeyError('invalid', 'crypto: the value is not JSON-serializable');
    }
    return this.encrypt(subject, text, options);
  }

  /** `JSON.parse(decrypt(ciphertext))`. */
  async decryptJson<T = unknown>(ciphertext: string, options: OpenOptions = {}): Promise<T> {
    const text = await this.decrypt(ciphertext, options);
    try {
      return JSON.parse(text) as T;
    } catch {
      // Never echo the plaintext (JSON.parse puts a slice of it in its message).
      throw new SubjectKeyError('invalid', 'crypto: the decrypted value is not valid JSON');
    }
  }

  /**
   * Whether a stored value should be rewritten: it is not a subject ciphertext (plaintext), it
   * belongs to another subject than `subject`, or its data key is no longer the subject's current
   * one (after `rotateDataKey`). Reads the local store only.
   */
  async needsReencrypt(value: unknown, subject: SubjectRef): Promise<boolean> {
    const parsed = readSubjectCiphertext(value);
    if (!parsed) return true;
    const key = this.keyName(subject);
    if (parsed.key !== key) return true;
    const cached = this.cache.current(key);
    if (cached) return cached.id !== parsed.dataKeyId;
    const current = await this.store.current(key);
    return current?.id !== parsed.dataKeyId;
  }

  /**
   * Rewraps every stored data key under the latest version of its subject key (after rotating
   * subject keys on the control plane), in pages. The data keys — and so the data — do not change;
   * the plaintext data key never leaves the control plane. Resumable: pass the last id as `after`.
   */
  async rewrapDataKeys(
    options: {
      subject?: SubjectRef;
      after?: string;
      batchSize?: number;
      onBatch?: (progress: RewrapDataKeysResult & { cursor: string }) => void | Promise<void>;
    } = {},
  ): Promise<RewrapDataKeysResult & { cursor?: string }> {
    const key = options.subject !== undefined ? this.keyName(options.subject) : undefined;
    const limit = Math.max(1, Math.floor(options.batchSize ?? 200));
    const totals: RewrapDataKeysResult = { scanned: 0, rewrapped: 0, forgotten: 0 };
    const latest = new Map<string, number | null>();
    let cursor = options.after;
    for (;;) {
      const page = await this.store.page({
        limit,
        ...(cursor !== undefined ? { after: cursor } : {}),
        ...(key !== undefined ? { key } : {}),
      });
      if (page.length === 0) break;
      for (const record of page) {
        totals.scanned += 1;
        const outcome = await this.#rewrapOne(record, latest);
        if (outcome === 'rewrapped') totals.rewrapped += 1;
        if (outcome === 'forgotten') totals.forgotten += 1;
      }
      cursor = page[page.length - 1]!.id;
      await options.onBatch?.({ ...totals, cursor });
      if (page.length < limit) break;
    }
    return { ...totals, ...(cursor !== undefined ? { cursor } : {}) };
  }

  async #rewrapOne(
    record: DataKeyRecord,
    latest: Map<string, number | null>,
  ): Promise<'rewrapped' | 'current' | 'forgotten'> {
    if (!latest.has(record.key)) {
      try {
        const view = await this.#operations.getKey(record.key);
        latest.set(record.key, view.deletedAt !== undefined ? null : view.latestVersion);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code !== 'not_found' && code !== 'deleted') {
          throw fromControlPlane(error, `rewrap ${record.key}`);
        }
        latest.set(record.key, null);
      }
    }
    const newest = latest.get(record.key);
    if (newest === null || newest === undefined) return 'forgotten';
    if (readCiphertext(record.wrapped)?.version === newest) return 'current';
    let rewrapped: { ciphertext: string };
    try {
      rewrapped = await this.#operations.rewrap({
        key: record.key,
        ciphertext: record.wrapped,
        aad: dataKeyAad(record.id),
        context: AUDIT_CONTEXT,
      });
    } catch (error) {
      throw fromControlPlane(error, `rewrap ${record.key}`);
    }
    await this.store.updateWrapped(record.id, record.wrapped, rewrapped.ciphertext);
    return 'rewrapped';
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Data keys                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  #epoch(key: string): number {
    return this.#epochs.get(key) ?? 0;
  }

  #bump(key: string): void {
    this.#epochs.set(key, this.#epoch(key) + 1);
  }

  #assertNotForgotten(key: string): void {
    if (this.#forgotten.has(key)) {
      throw new SubjectKeyError('forgotten', `crypto: ${key}: the subject was forgotten`);
    }
  }

  /** A private copy of a data key's bytes; the caller zeroes it. */
  #copy(entry: CachedDataKey): Buffer {
    return Buffer.from(entry.bytes);
  }

  async #dataKey(id: string, key: string, track?: 'decrypt'): Promise<Buffer> {
    this.#assertNotForgotten(key);
    const cached = this.cache.get(id);
    if (cached) {
      if (cached.key !== key) {
        throw new SubjectKeyError('invalid', 'crypto: the ciphertext names another subject key');
      }
      return this.#copy(cached);
    }
    if (track) this.#reportMiss(key, track);
    let pending = this.#unwrapping.get(id);
    let bytes: Buffer | undefined;
    if (!pending) {
      pending = (async () => {
        const record = await this.store.get(id);
        if (!record) {
          throw new SubjectKeyError(
            'forgotten',
            `crypto: no data key ${id} (the subject was forgotten, or its crypto_data_keys row is gone)`,
          );
        }
        if (record.key !== key) {
          throw new SubjectKeyError('invalid', 'crypto: the ciphertext names another subject key');
        }
        bytes = await this.#unwrap(record);
      })();
      this.#unwrapping.set(id, pending);
      pending.finally(() => this.#unwrapping.delete(id)).catch(() => {});
    }
    await pending;
    // The caller that did the unwrap holds its own copy; everyone else reads the cache (or, with
    // the cache off or the entry already evicted, unwraps once more).
    if (bytes) return bytes;
    const entry = this.cache.get(id);
    if (entry) return this.#copy(entry);
    const record = await this.store.get(id);
    if (!record) throw new SubjectKeyError('forgotten', `crypto: no data key ${id}`);
    return this.#unwrap(record);
  }

  /** Unwraps a stored data key on the control plane and caches it; returns a private copy. */
  async #unwrap(
    record: DataKeyRecord,
    options: { current?: boolean; epoch?: number } = {},
  ): Promise<Buffer> {
    let plaintext: string;
    try {
      ({ plaintext } = await this.#operations.decrypt({
        key: record.key,
        ciphertext: record.wrapped,
        aad: dataKeyAad(record.id),
        context: AUDIT_CONTEXT,
      }));
    } catch (error) {
      throw fromControlPlane(error, `unwrap a data key of ${record.key}`);
    }
    return this.#accept(record.id, record.key, plaintext, options);
  }

  #accept(
    id: string,
    key: string,
    plaintext: string,
    options: { current?: boolean; epoch?: number },
  ): Buffer {
    const decoded = Buffer.from(plaintext, 'base64url');
    try {
      // Checked after the await that produced the key: a forget that ran meanwhile wins.
      this.#assertNotForgotten(key);
      if (decoded.length !== 32 || decoded.toString('base64url') !== plaintext) {
        throw new SubjectKeyError('invalid', `crypto: data key ${id} is not a 32-byte key`);
      }
      const current =
        options.current === true &&
        (options.epoch === undefined || options.epoch === this.#epoch(key));
      return this.cache.set(id, key, decoded, { current });
    } finally {
      decoded.fill(0);
    }
  }

  async #currentDataKey(key: string, track?: 'encrypt'): Promise<{ id: string; bytes: Buffer }> {
    for (let attempt = 0; ; attempt += 1) {
      this.#assertNotForgotten(key);
      const cached = this.cache.current(key);
      if (cached) return { id: cached.id, bytes: this.#copy(cached) };
      if (track && attempt === 0) this.#reportMiss(key, track);
      const rotation = this.#rotating.get(key);
      if (rotation) {
        await rotation.catch(() => {});
        continue;
      }
      if (!this.cache.enabled) return this.#provisionUncached(key);
      const epoch = this.#epoch(key);
      let pending = this.#provisioning.get(key);
      if (!pending) {
        const started = this.#provision(key, epoch);
        pending = started;
        this.#provisioning.set(key, started);
        started
          .finally(() => {
            if (this.#provisioning.get(key) === started) this.#provisioning.delete(key);
          })
          .catch(() => {});
      }
      const id = await pending;
      // A rotation (or a forget) ran while this was in flight: what it found may be retired.
      if (epoch !== this.#epoch(key) && attempt < 3) continue;
      return { id, bytes: await this.#dataKey(id, key) };
    }
  }

  /** With the cache off: the current data key (or a new one), one control-plane call. */
  async #provisionUncached(key: string): Promise<{ id: string; bytes: Buffer }> {
    const existing = await this.store.current(key);
    if (existing) return { id: existing.id, bytes: await this.#unwrap(existing) };
    const id = newDataKeyId();
    const generated = await this.#generate(key, id);
    if (generated.plaintext === undefined) {
      throw new SubjectKeyError('failed', 'crypto: the control plane returned no data key');
    }
    await this.store.insert({ id, key, wrapped: generated.wrapped, createdAt: this.#now() });
    if (this.#forgotten.has(key)) await this.store.deleteKey(key);
    return { id, bytes: this.#accept(id, key, generated.plaintext, {}) };
  }

  /** Loads (or creates) the subject's current data key into the cache; returns its id. */
  async #provision(key: string, epoch: number): Promise<string> {
    const existing = await this.store.current(key);
    if (existing) {
      (await this.#unwrap(existing, { current: true, epoch })).fill(0);
      return existing.id;
    }
    const id = newDataKeyId();
    const generated = await this.#generate(key, id);
    if (generated.plaintext === undefined) {
      throw new SubjectKeyError('failed', 'crypto: the control plane returned no data key');
    }
    await this.store.insert({ id, key, wrapped: generated.wrapped, createdAt: this.#now() });
    if (this.#forgotten.has(key)) {
      // Forgotten while the data key was being made: drop the row this call just wrote.
      await this.store.deleteKey(key);
    }
    this.#accept(id, key, generated.plaintext, { current: true, epoch }).fill(0);
    return id;
  }

  async #generate(key: string, id: string): Promise<{ plaintext?: string; wrapped: string }> {
    const input = { key, aad: dataKeyAad(id), context: AUDIT_CONTEXT };
    try {
      return await this.#operations.generateDataKey(input);
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'not_found') {
        throw fromControlPlane(error, `a data key for ${key}`);
      }
      if (!this.#lazy) {
        throw new SubjectKeyError(
          'invalid',
          `crypto: subject key "${key}" does not exist (createKeys is "explicit": call subjects.create first)`,
          { cause: error },
        );
      }
    }
    await this.#createKey(key);
    try {
      return await this.#operations.generateDataKey(input);
    } catch (error) {
      throw fromControlPlane(error, `a data key for ${key}`);
    }
  }

  /** Creates a subject key; `false` when it already existed. A forgotten subject stays forgotten. */
  async #createKey(key: string): Promise<boolean> {
    try {
      await this.#operations.createKey({
        name: key,
        type: 'aes256-gcm',
        description: 'subject key (@adonis-agora/crypto subjects)',
        deletionAllowed: true,
      });
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (
        code === 'forbidden' ||
        code === 'unauthenticated' ||
        code === 'network' ||
        code === 'timeout'
      ) {
        throw fromControlPlane(error, `create ${key}`);
      }
      // A conflict — or a race with another process creating it (some stores report that as a
      // plain error) — is either "exists" (fine) or "the name belonged to a deleted key".
      let view: { deletedAt?: string };
      try {
        view = await this.#operations.getKey(key);
      } catch {
        throw fromControlPlane(error, `create ${key}`);
      }
      if (view.deletedAt !== undefined) {
        throw new SubjectKeyError('forgotten', `crypto: ${key}: the subject was forgotten`);
      }
      return false;
    }
  }
}
