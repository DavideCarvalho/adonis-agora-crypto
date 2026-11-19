import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Cipher, CipherSource } from './source.js';
import { cryptoServerUse, describeStackUse } from './stack.js';

/*
 * `@adonis-agora/collaboration` is an optional peer: its storage codec contract is declared
 * structurally below (the same shapes as its `StorageCodec`, `StorageCodecContext` and
 * `StorageCodecValue`), so nothing here imports it, at runtime or for types. Nothing here imports
 * `@adonis-agora/crypto` at runtime either: an app on another crypto version loads this subpath
 * without a second copy of the crypto lib.
 */

/** What the collaboration storage hands a codec: raw bytes, or a string. */
export type CollaborationCodecValue = Uint8Array | string;

/** `StorageCodecContext` of `@adonis-agora/collaboration`. */
export interface CollaborationCodecContext {
  docName: string;
  kind: 'document' | 'version' | 'comment';
  field: 'state' | 'snapshot' | 'body' | 'anchor';
  versionId?: string;
  commentId?: string;
  meta?: Record<string, unknown> | null;
}

/** A subject reference, as `crypto.subjects` takes it. */
export type CollaborationSubjectRef = string | number | { type: string; id: string | number };

/**
 * The two calls of `crypto.subjects` (`SubjectKeys`) the codec uses, declared structurally so any
 * installed copy of `@adonis-agora/crypto` fits.
 */
export interface SubjectCipher {
  encrypt(
    subject: CollaborationSubjectRef,
    plaintext: string,
    options?: { aad?: string },
  ): Promise<string>;
  decrypt(
    ciphertext: string,
    options?: { subject?: CollaborationSubjectRef; aad?: string },
  ): Promise<string>;
}

interface BaseOptions<M> {
  /**
   * Which documents are encrypted. A `RegExp` is matched against `docName` (the match is passed on
   * to `subject`/`key`); a function returns a match, or `null` for a document that passes through
   * untouched. Default: every document.
   */
  docs?: RegExp | ((docName: string) => M | null | undefined | false);
  /** The AAD bound into every value. Default: {@link collaborationAad}. */
  aad?: (ctx: CollaborationCodecContext) => string;
}

/** Per-subject keys: each matched document is sealed with its subject's key (`crypto.subjects`). */
export interface SubjectCodecOptions<M> extends BaseOptions<M> {
  /** `crypto.subjects`, or a getter for it (read at the first encode/decode, not at boot). */
  subjects: SubjectCipher | (() => SubjectCipher);
  /** The subject whose key seals a document. */
  subject: (
    match: M,
    ctx: CollaborationCodecContext,
  ) => CollaborationSubjectRef | Promise<CollaborationSubjectRef>;
  source?: never;
  key?: never;
  envelope?: never;
}

/** A named key on the crypto server. */
export interface KeyCodecOptions<M> extends BaseOptions<M> {
  source: CipherSource;
  /** The key name, or a function picking it per document. */
  key: string | ((match: M, ctx: CollaborationCodecContext) => string);
  /**
   * Opt-in: seal locally under a data key per document instead of sending every value to the crypto
   * server. The data key is wrapped by `key` (one server call per document and `ttlMs`), cached
   * briefly, and travels inside each value (`agora:ce1:`). Values written either way stay readable
   * whatever this option says.
   */
  envelope?: boolean | { ttlMs?: number; maxEntries?: number };
  subjects?: never;
  subject?: never;
}

export type CollaborationCodecOptions<M = RegExpExecArray> =
  | SubjectCodecOptions<M>
  | KeyCodecOptions<M>;

/** A `StorageCodec` for `lucidStorage({ codec })` / `withCodec(...)`. */
export interface CollaborationCodec {
  encode(
    plaintext: CollaborationCodecValue,
    ctx: CollaborationCodecContext,
  ): Promise<CollaborationCodecValue>;
  decode(
    encoded: CollaborationCodecValue,
    ctx: CollaborationCodecContext,
  ): Promise<CollaborationCodecValue>;
}

/**
 * The default AAD: binds a value to its document, row kind, column and version/comment, so a
 * ciphertext copied to another row or column does not open.
 */
export function collaborationAad(ctx: CollaborationCodecContext): string {
  return JSON.stringify([
    'agora:collab',
    ctx.docName,
    ctx.kind,
    ctx.field,
    ctx.versionId ?? ctx.commentId ?? null,
  ]);
}

/** The prefix of an envelope-mode value. */
export const COLLABORATION_ENVELOPE_PREFIX = 'agora:ce1:';

const isText = (ctx: CollaborationCodecContext) => ctx.field === 'body' || ctx.field === 'anchor';

const toText = (value: CollaborationCodecValue) =>
  typeof value === 'string' ? value : Buffer.from(value).toString('base64');

const fromText = (text: string, ctx: CollaborationCodecContext): CollaborationCodecValue =>
  isText(ctx) ? text : new Uint8Array(Buffer.from(text, 'base64'));

const asCiphertext = (value: CollaborationCodecValue) =>
  typeof value === 'string' ? value : Buffer.from(value).toString('utf8');

/**
 * Encryption at rest for `@adonis-agora/collaboration` (its storage `codec`): document state,
 * version snapshots, comment bodies and anchors of the matched documents are sealed; the other
 * documents pass through untouched.
 *
 * ```ts title="config/collaboration.ts"
 * storage: lucidStorage({
 *   codec: collaborationCodec({
 *     docs: /^projects\/([^/]+)\/writing$/,
 *     subjects: () => crypto.subjects,
 *     subject: async ([, projectId]) => ownerSubject(projectId),
 *   }),
 * })
 * ```
 *
 * Binary values are base64'd before sealing; the result is the ciphertext string. Decryption
 * failures throw (the storage then refuses to overwrite the document); plaintext is never logged.
 */
export function collaborationCodec<M = RegExpExecArray>(
  options: CollaborationCodecOptions<M>,
): CollaborationCodec {
  const matchOf = matcher(options.docs);
  const aadOf = options.aad ?? collaborationAad;

  let seal: (match: M, text: string, ctx: CollaborationCodecContext) => Promise<string>;
  let open: (match: M, ciphertext: string, ctx: CollaborationCodecContext) => Promise<string>;

  if (options.subjects !== undefined) {
    if (typeof options.subject !== 'function') {
      throw new TypeError('crypto: collaborationCodec with `subjects` needs a `subject` function');
    }
    if (options.source !== undefined || options.key !== undefined) {
      throw new TypeError(
        'crypto: collaborationCodec takes `subjects` or `source` + `key`, not both',
      );
    }
    if (options.envelope !== undefined) {
      throw new TypeError(
        'crypto: `envelope` is for a named key; subject keys already seal locally under data keys',
      );
    }
    const subjectsOption = options.subjects;
    const subjects = (): SubjectCipher =>
      typeof subjectsOption === 'function' ? subjectsOption() : subjectsOption;
    const subjectOf = options.subject;
    seal = async (match, text, ctx) =>
      subjects().encrypt(await subjectOf(match, ctx), text, { aad: aadOf(ctx) });
    open = async (match, ciphertext, ctx) =>
      subjects().decrypt(ciphertext, { subject: await subjectOf(match, ctx), aad: aadOf(ctx) });
  } else if (options.source !== undefined) {
    if (options.key === undefined) {
      throw new TypeError('crypto: collaborationCodec with `source` needs a `key`');
    }
    const cipher = cipherOf(options.source);
    const keyOption = options.key;
    const keyOf = (match: M, ctx: CollaborationCodecContext) =>
      typeof keyOption === 'function' ? keyOption(match, ctx) : keyOption;
    const envelope = options.envelope
      ? new DocumentDataKeys(cipher, options.envelope === true ? {} : options.envelope)
      : undefined;
    seal = async (match, text, ctx) => {
      const key = keyOf(match, ctx);
      if (envelope) return envelope.seal(key, text, ctx.docName, aadOf(ctx));
      return (await cipher.encrypt({ key, plaintext: text, aad: aadOf(ctx) })).ciphertext;
    };
    open = async (match, ciphertext, ctx) => {
      const key = keyOf(match, ctx);
      // Both formats open whatever `envelope` says now, so the option can be turned on and off.
      if (ciphertext.startsWith(COLLABORATION_ENVELOPE_PREFIX)) {
        return (envelope ?? new DocumentDataKeys(cipher, { ttlMs: 0 })).open(
          key,
          ciphertext,
          ctx.docName,
          aadOf(ctx),
        );
      }
      return (await cipher.decrypt({ key, ciphertext, aad: aadOf(ctx) })).plaintext;
    };
  } else {
    throw new TypeError(
      'crypto: collaborationCodec needs `subjects` + `subject`, or `source` + `key`',
    );
  }

  const codec: CollaborationCodec = {
    async encode(plaintext, ctx) {
      const match = matchOf(ctx.docName);
      if (match === null) return plaintext;
      return seal(match, toText(plaintext), ctx);
    },
    async decode(encoded, ctx) {
      const match = matchOf(ctx.docName);
      if (match === null) return encoded;
      return fromText(await open(match, asCiphertext(encoded), ctx), ctx);
    },
  };
  return describeStackUse(codec, cryptoServerUse('collaboration documents'));
}

/** `cipherFor` without its runtime import of `@adonis-agora/crypto` (any installed copy fits). */
function cipherOf(source: CipherSource): Cipher {
  if ('client' in source) return source.client;
  const { service, partition } = source;
  const principal = {
    partition,
    capabilities: ['crypto:*'],
    actor: source.actor ?? 'collaboration',
  };
  return {
    encrypt: (input) => service.encrypt(principal, input),
    decrypt: (input) => service.decrypt(principal, input),
  };
}

function matcher<M>(docs: CollaborationCodecOptions<M>['docs']): (docName: string) => M | null {
  if (docs === undefined) return (docName) => [docName] as unknown as M;
  if (docs instanceof RegExp) {
    // A stateful (g/y) regex would match every other call: drop those flags.
    const regex = new RegExp(docs.source, docs.flags.replace(/[gy]/g, ''));
    return (docName) => (regex.exec(docName) as M | null) ?? null;
  }
  return (docName) => {
    const match = docs(docName);
    return match === undefined || match === false || match === null ? null : match;
  };
}

/* ---------------------------------------------------------------------------------------------- */
/* Envelope mode                                                                                  */
/* ---------------------------------------------------------------------------------------------- */

/*
 * agora:ce1:<base64url(wrapped data key)>:<base64url(iv ‖ ciphertext ‖ tag)>
 *
 * The data key (32 random bytes) is wrapped by the named key on the crypto server with an AAD that
 * names the document, so a value moved to another document does not open. The body is AES-256-GCM
 * with a random 96-bit IV; its AAD binds the format, the wrapped key and the caller's AAD.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;
const B64URL = /^[A-Za-z0-9_-]+$/;
const wrapAad = (docName: string) => `agora:collab-dek:v1:${docName}`;
const bodyAad = (wrapped: string, aad: string) =>
  `${COLLABORATION_ENVELOPE_PREFIX}${wrapped}:${aad}`;

interface CachedKey {
  promise: Promise<{ wrapped: string; bytes: Buffer }>;
  expires: number;
}

class DocumentDataKeys {
  readonly #cipher: Cipher;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  /** Current data key per `key + docName` (encode side). */
  readonly #current = new Map<string, CachedKey>();
  /** Unwrapped data keys by wrapped form (decode side). */
  readonly #opened = new Map<string, CachedKey>();

  constructor(cipher: Cipher, options: { ttlMs?: number; maxEntries?: number }) {
    this.#cipher = cipher;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#maxEntries = options.maxEntries ?? 500;
  }

  async seal(key: string, text: string, docName: string, aad: string): Promise<string> {
    const { wrapped, bytes } = await this.#get(
      this.#current,
      `${key}\u0000${docName}`,
      async () => {
        const bytes = randomBytes(32);
        const { ciphertext } = await this.#cipher.encrypt({
          key,
          plaintext: bytes.toString('base64'),
          aad: wrapAad(docName),
        });
        const wrapped = Buffer.from(ciphertext, 'utf8').toString('base64url');
        // This process can open what it seals without asking the server again.
        this.#remember(this.#opened, `${key}\u0000${docName}\u0000${wrapped}`, { wrapped, bytes });
        return { wrapped, bytes };
      },
    );
    const iv = randomBytes(IV_BYTES);
    const gcm = createCipheriv('aes-256-gcm', bytes, iv);
    gcm.setAAD(Buffer.from(bodyAad(wrapped, aad), 'utf8'));
    const body = Buffer.concat([iv, gcm.update(text, 'utf8'), gcm.final(), gcm.getAuthTag()]);
    return `${COLLABORATION_ENVELOPE_PREFIX}${wrapped}:${body.toString('base64url')}`;
  }

  async open(key: string, value: string, docName: string, aad: string): Promise<string> {
    const parts = value.slice(COLLABORATION_ENVELOPE_PREFIX.length).split(':');
    const [wrapped, encoded] = parts as [string, string];
    if (parts.length !== 2 || !B64URL.test(wrapped) || !B64URL.test(encoded)) {
      throw new Error('crypto: malformed agora:ce1 collaboration value');
    }
    const body = Buffer.from(encoded, 'base64url');
    if (body.byteLength < IV_BYTES + TAG_BYTES) {
      throw new Error('crypto: malformed agora:ce1 collaboration value');
    }
    const { bytes } = await this.#get(
      this.#opened,
      `${key}\u0000${docName}\u0000${wrapped}`,
      async () => {
        const { plaintext } = await this.#cipher.decrypt({
          key,
          ciphertext: Buffer.from(wrapped, 'base64url').toString('utf8'),
          aad: wrapAad(docName),
        });
        const bytes = Buffer.from(plaintext, 'base64');
        if (bytes.byteLength !== 32)
          throw new Error('crypto: a collaboration data key is malformed');
        return { wrapped, bytes };
      },
    );
    try {
      const gcm = createDecipheriv('aes-256-gcm', bytes, body.subarray(0, IV_BYTES));
      gcm.setAAD(Buffer.from(bodyAad(wrapped, aad), 'utf8'));
      gcm.setAuthTag(body.subarray(body.byteLength - TAG_BYTES));
      return Buffer.concat([
        gcm.update(body.subarray(IV_BYTES, body.byteLength - TAG_BYTES)),
        gcm.final(),
      ]).toString('utf8');
    } catch {
      // Never surface the cipher's message (or anything of the value).
      throw new Error('crypto: a collaboration value did not open (wrong key, document or AAD)');
    }
  }

  #remember(cache: Map<string, CachedKey>, id: string, value: { wrapped: string; bytes: Buffer }) {
    if (this.#ttlMs <= 0) return;
    cache.set(id, { promise: Promise.resolve(value), expires: Date.now() + this.#ttlMs });
    this.#trim(cache);
  }

  #trim(cache: Map<string, CachedKey>) {
    while (cache.size > this.#maxEntries) {
      const oldest = cache.keys().next().value as string;
      cache.delete(oldest);
    }
  }

  async #get(
    cache: Map<string, CachedKey>,
    id: string,
    load: () => Promise<{ wrapped: string; bytes: Buffer }>,
  ): Promise<{ wrapped: string; bytes: Buffer }> {
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && hit.expires > now) return hit.promise;
    if (hit) cache.delete(id);
    const promise = load();
    if (this.#ttlMs <= 0) return promise;
    const entry: CachedKey = { promise, expires: now + this.#ttlMs };
    cache.set(id, entry);
    // A failed load is not cached.
    promise.catch(() => {
      if (cache.get(id) === entry) cache.delete(id);
    });
    this.#trim(cache);
    return promise;
  }
}
