import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingHttpHeaders } from 'node:http';
import {
  cryptoEnvelope,
  ENVELOPE_FIELD,
  ENVELOPE_HEADER,
  ENVELOPE_VERSION,
  type EnvelopeCipher,
} from '@adonis-agora/crypto-core';
import type { CryptoConfig, CryptoEnvelopeConfig } from '../define_config.js';

/** The `aes256-gcm` key name the caller sealed with. Never the key itself. */
export const ENVELOPE_KEY_HEADER = 'x-crypto-key';

/**
 * The shared slot telescope publishes its service discovery on. Crypto must never import telescope:
 * it reads this value at request time, so the order the two providers boot in does not matter.
 */
export const DISCOVERY_SLOT = Symbol.for('@adonis-agora/discovery');

/** The part of telescope's discovery crypto uses. Reads are synchronous (a local snapshot). */
export interface AgoraDiscovery {
  /** The app an origin belongs to, or undefined when unknown. The only method crypto requires. */
  appOf(origin: string): string | undefined;
  /** The app name → its origin. Only needed before telescope rewrote a symbolic host. */
  resolve?(name: string): string | undefined;
  /** Announced when the snapshot changes. Crypto does not cache, so it does not need to subscribe. */
  subscribe?(listener: (apps: Record<string, string>) => void): () => void;
}

/** The resolved inbound half, carried on the runtime so the middleware never reads global state. */
export interface ResolvedInboundEnvelope {
  accept: string[];
  cipher: EnvelopeCipher;
  maxAgeSec: number;
  clockSkewSec: number;
  maxBytes: number;
  required: boolean;
  aad?: string;
  /** Server-side only: the actual reason a request was refused (never echoed to the caller). */
  warn?(message: string): void;
}

/** One configured target: the app name, its exact origin and the key that hop uses. */
interface StaticTarget {
  name: string;
  origin: string;
  key?: string;
}

/** Everything the outbound interceptor needs, resolved once at boot. */
export interface ResolvedOutboundEnvelope {
  /** The key every hub call uses when a target does not override it. */
  key?: string;
  aad?: string;
  cipher: EnvelopeCipher;
  /** Configured origins — the fallback when telescope's discovery slot is absent. */
  byOrigin: Map<string, StaticTarget>;
  /** Configured names → target, so a discovered app can still get its own key. */
  byName: Map<string, StaticTarget>;
  /** Paths that are crypto's own API (`/_crypto`), never sealed: sealing them would recurse. */
  skipPaths: string[];
}

export interface InstallEnvelopeOptions {
  config: CryptoEnvelopeConfig;
  outboundCipher: EnvelopeCipher;
  inboundCipher?: EnvelopeCipher;
  /** Crypto's own API paths, never sealed. Default `['/_crypto']`. */
  skipPaths?: string[];
  warn?(message: string): void;
}

export interface InstalledEnvelope {
  inbound?: ResolvedInboundEnvelope;
}

/** Marks the async work of sealing, so the cipher's own HTTP call never gets sealed (recursion). */
const sealing = new AsyncLocalStorage<true>();

/** Runs `fn` with outbound sealing bypassed for every request it makes. */
export function withoutEnvelope<T>(fn: () => Promise<T>): Promise<T> {
  return sealing.run(true, fn);
}

function isSealing(): boolean {
  return sealing.getStore() === true;
}

/** The discovery telescope published, when it is usable. Absent → the static map is the source. */
export function agoraDiscovery(): AgoraDiscovery | undefined {
  const value = (globalThis as Record<symbol, unknown>)[DISCOVERY_SLOT] as
    | Partial<AgoraDiscovery>
    | undefined;
  if (!value || typeof value.appOf !== 'function') return undefined;
  return value as AgoraDiscovery;
}

function sync<T>(fn: () => T): T | undefined {
  try {
    const value = fn();
    // A snapshot lookup has no business being async; treat one as "unknown" instead of sealing blind.
    if (value && typeof (value as { then?: unknown }).then === 'function') return undefined;
    return value;
  } catch {
    return undefined;
  }
}

const SINGLE_LABEL = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * The app a request is going to: telescope's discovery first (it has already rewritten
 * `http://billing/…` to the real origin by the time this runs), then the static map.
 */
function appOf(url: URL, outbound: ResolvedOutboundEnvelope): string | undefined {
  const discovery = agoraDiscovery();
  if (discovery) {
    const app = sync(() => discovery.appOf(url.origin));
    if (typeof app === 'string' && app !== '') return app;
    // The symbolic host has not been rewritten yet (crypto booted before telescope): the name is
    // still the app, so the body can be sealed now — the URL itself stays telescope's business.
    if (SINGLE_LABEL.test(url.hostname) && typeof discovery.resolve === 'function') {
      const resolve = discovery.resolve.bind(discovery);
      const resolved = sync(() => resolve(url.hostname));
      if (typeof resolved === 'string' && resolved !== '') return url.hostname;
    }
  }
  return outbound.byOrigin.get(url.origin)?.name;
}

function keyOf(app: string, outbound: ResolvedOutboundEnvelope): string | undefined {
  return outbound.byName.get(app)?.key ?? outbound.key;
}

type DispatcherOptions = {
  origin?: string | URL;
  path: string;
  method: string;
  headers?: IncomingHttpHeaders | string[] | null;
  body?: unknown;
};

type Dispatch = (options: DispatcherOptions, handler: unknown) => boolean;

interface DispatcherLike {
  compose?(interceptors: unknown[]): DispatcherLike;
}

const DISPATCHER_V1 = Symbol.for('undici.globalDispatcher.1');
const DISPATCHER_V2 = Symbol.for('undici.globalDispatcher.2');

function headersOf(headers: DispatcherOptions['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  // A `Headers` instance is iterable but has no own enumerable properties, so `Object.entries`
  // would silently drop every header (including the authorization one).
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    for (const [name, value] of headers.entries()) result[String(name).toLowerCase()] = value;
    return result;
  }
  if (Array.isArray(headers)) {
    if (headers.every((entry) => Array.isArray(entry))) {
      for (const [name, value] of headers as unknown as Array<[string, string]>) {
        result[String(name).toLowerCase()] = String(value);
      }
    } else {
      for (let index = 0; index + 1 < headers.length; index += 2) {
        result[String(headers[index]).toLowerCase()] = String(headers[index + 1]);
      }
    }
    return result;
  }
  if (headers && typeof (headers as unknown as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const entry of headers as unknown as Iterable<[string, string]>) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      result[String(entry[0]).toLowerCase()] = String(entry[1]);
    }
    return result;
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    result[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return result;
}

/** Bodies that can be read and replaced without changing what the app meant to send. */
function isSealable(contentType: string | undefined): boolean {
  const type = (contentType ?? '').toLowerCase().split(';')[0]!.trim();
  // Anything binary, form or multipart keeps its own encoding: sealing it would change the bytes.
  if (type === '' || type === 'application/json' || type.endsWith('+json')) return true;
  // `fetch` labels a plain string body `text/plain`; app-to-app JSON is often sent exactly like that.
  return type === 'text/plain';
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  }
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('crypto: the request body is not text');
}

async function bodyText(body: unknown): Promise<string> {
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString('utf8');
  const iterable = body as { [Symbol.asyncIterator]?: () => AsyncIterator<unknown> };
  if (
    body !== null &&
    typeof body === 'object' &&
    typeof iterable[Symbol.asyncIterator] === 'function'
  ) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<unknown>) chunks.push(toBuffer(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  throw new TypeError('crypto: the request body is not text');
}

function payloadOf(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * The outbound interceptor: composes onto whatever dispatcher is already global, so the trace
 * (telescope) and identity (authkit-client) interceptors stay in the chain.
 *
 * The body is not read here — `dispatch` must return synchronously — it is replaced by an async
 * generator that seals when undici consumes it. If sealing fails, the request fails: plaintext is
 * never sent.
 */
function envelopeInterceptor(resolved: ResolvedOutboundEnvelope) {
  return (dispatch: Dispatch) =>
    (options: DispatcherOptions, handler: unknown): boolean => {
      let url: URL;
      try {
        url = new URL(options.path, options.origin as string | URL | undefined);
      } catch {
        return dispatch(options, handler);
      }
      if (isSealing()) return dispatch(options, handler);
      if (options.body === undefined || options.body === null) return dispatch(options, handler);
      const method = (options.method ?? 'GET').toUpperCase();
      if (method === 'GET' || method === 'HEAD') return dispatch(options, handler);
      if (
        resolved.skipPaths.some(
          (path) => url.pathname === path || url.pathname.startsWith(`${path}/`),
        )
      ) {
        return dispatch(options, handler);
      }
      const app = appOf(url, resolved);
      if (app === undefined) return dispatch(options, handler);
      const key = keyOf(app, resolved);
      if (key === undefined) return dispatch(options, handler);

      const headers = headersOf(options.headers);
      // Already sealed (`cryptoFetch`, or a second interceptor in the chain): never seal twice.
      if (headers[ENVELOPE_HEADER] !== undefined) return dispatch(options, handler);
      if (!isSealable(headers['content-type'])) return dispatch(options, handler);

      headers['content-type'] = 'application/json';
      headers[ENVELOPE_HEADER] = ENVELOPE_VERSION;
      headers[ENVELOPE_KEY_HEADER] = key;
      // The sealed body has a different length; undici must not reuse the clear one.
      delete headers['content-length'];

      const original = options.body;
      const envelope = cryptoEnvelope({
        client: resolved.cipher,
        key,
        ...(resolved.aad !== undefined ? { aad: resolved.aad } : {}),
      });
      options.headers = headers;
      options.body = (async function* sealed() {
        const text = await bodyText(original);
        const ciphertext = await withoutEnvelope(() => envelope.seal(payloadOf(text)));
        yield Buffer.from(JSON.stringify({ [ENVELOPE_FIELD]: ciphertext }));
      })();

      return dispatch(options, handler);
    };
}

/**
 * Composes the interceptor onto Node's global dispatcher. It never replaces the dispatcher: it reads
 * the current one and composes, which is what keeps this compatible with every other interceptor.
 *
 * When no dispatcher exists yet, Node has not materialised one; a `data:` fetch does that without
 * touching the network. Both known slots are kept in sync so a later `undici` import (which reads
 * `.2` and rewrites `.1`) finds a dispatcher instead of installing a fresh, interceptor-less one.
 */
async function installDispatcher(resolved: ResolvedOutboundEnvelope): Promise<boolean> {
  const slots = globalThis as unknown as Record<symbol, DispatcherLike | undefined>;
  if (!slots[DISPATCHER_V1] && !slots[DISPATCHER_V2]) {
    try {
      await fetch('data:text/plain,');
    } catch {
      // No global fetch: there is nothing to intercept.
    }
  }
  const v1 = slots[DISPATCHER_V1];
  const v2 = slots[DISPATCHER_V2];
  const interceptor = envelopeInterceptor(resolved);
  const compose = (base: DispatcherLike): DispatcherLike | undefined =>
    typeof base.compose === 'function' ? base.compose([interceptor]) : undefined;

  if (v1 && v2 && v1 !== v2) {
    const composedV1 = compose(v1);
    const composedV2 = compose(v2);
    if (composedV1) slots[DISPATCHER_V1] = composedV1;
    if (composedV2) slots[DISPATCHER_V2] = composedV2;
    return Boolean(composedV1 ?? composedV2);
  }
  const base = v1 ?? v2;
  if (!base) return false;
  const composed = compose(base);
  if (!composed) return false;
  slots[DISPATCHER_V1] = composed;
  slots[DISPATCHER_V2] ??= composed;
  return true;
}

function resolveTargets(
  config: CryptoEnvelopeConfig,
): Pick<ResolvedOutboundEnvelope, 'byOrigin' | 'byName'> {
  const byOrigin = new Map<string, StaticTarget>();
  const byName = new Map<string, StaticTarget>();
  for (const [name, target] of Object.entries(config.targets ?? {})) {
    const url = typeof target === 'string' ? target : target.url;
    const key = typeof target === 'string' ? undefined : target.key;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new Error(`crypto: envelope.targets.${name} is not an absolute http(s) URL`);
    }
    const resolved: StaticTarget = { name, origin, ...(key !== undefined ? { key } : {}) };
    byOrigin.set(origin, resolved);
    byName.set(name, resolved);
  }
  return { byOrigin, byName };
}

function resolveAccept(config: CryptoEnvelopeConfig): string[] {
  if (config.accept !== undefined) {
    return typeof config.accept === 'string' ? [config.accept] : [...config.accept];
  }
  return config.key !== undefined ? [config.key] : [];
}

/**
 * Crypto's own API paths, which must never be sealed: sealing a call to the crypto server would need
 * another crypto call, which would need another seal. The tenant knows its server URL; a server knows
 * its mount prefix.
 */
export function envelopeSkipPaths(config: CryptoConfig): string[] {
  const paths = new Set<string>(['/_crypto']);
  const add = (value: string | undefined) => {
    if (!value) return;
    const trimmed = value.replace(/\/$/, '');
    if (trimmed !== '' && trimmed.startsWith('/')) paths.add(trimmed);
  };
  if (config.topology === 'tenant') {
    try {
      add(new URL(config.tenant.url).pathname);
    } catch {
      // defineConfig already refuses a relative URL; nothing to skip beyond the default.
    }
  } else if (config.topology === 'control-plane') {
    add(config.prefix);
  }
  return [...paths];
}

/**
 * Installs both halves of app-to-app encryption from `config/crypto.ts`:
 *
 * ```ts
 * envelope: {
 *   key: 'svc-hub',                                   // the shared aes256-gcm key
 *   targets: { billing: 'https://billing.internal' }, // fallback when telescope is absent
 * }
 * ```
 *
 * With telescope in the app, its discovery slot identifies the target app and `targets` is not
 * needed; without it, only the configured exact origins are sealed.
 */
export async function installCryptoEnvelope(
  options: InstallEnvelopeOptions,
): Promise<InstalledEnvelope> {
  const config = options.config;
  const { byOrigin, byName } = resolveTargets(config);
  const outbound = config.outbound !== false;
  if (outbound && config.key === undefined) {
    throw new Error(
      'crypto: `envelope.key` is required (the shared aes256-gcm key every app holds under the same name); set `outbound: false` for an inbound-only app',
    );
  }

  let installed = false;
  if (outbound) {
    installed = await installDispatcher({
      ...(config.key !== undefined ? { key: config.key } : {}),
      ...(config.aad !== undefined ? { aad: config.aad } : {}),
      cipher: options.outboundCipher,
      byOrigin,
      byName,
      skipPaths: options.skipPaths ?? ['/_crypto'],
    });
    if (!installed) {
      options.warn?.(
        '[@adonis-agora/crypto] envelope: no global fetch/undici dispatcher to compose onto; outbound sealing is off',
      );
    }
  }

  if (config.inbound === false || options.inboundCipher === undefined) return {};
  const accept = resolveAccept(config);
  if (accept.length === 0) return {};
  return {
    inbound: {
      accept,
      cipher: options.inboundCipher,
      maxAgeSec: config.maxAgeSec ?? 300,
      clockSkewSec: config.clockSkewSec ?? 60,
      maxBytes: config.maxBytes ?? 2 * 1024 * 1024,
      required: config.required === true,
      ...(config.aad !== undefined ? { aad: config.aad } : {}),
      ...(options.warn !== undefined ? { warn: options.warn } : {}),
    },
  };
}

/**
 * Reads the raw request body, or returns the one a body parser already produced. The cap keeps a
 * hostile envelope from becoming memory pressure; over the cap the stream is drained, not stored.
 */
export async function readEnvelopeBody(
  ctx: {
    request: {
      request?: { headers?: IncomingHttpHeaders } & AsyncIterable<unknown>;
      raw?: () => string | null;
      body?: () => unknown;
    };
  },
  maxBytes: number,
): Promise<{ body?: Record<string, unknown>; tooLarge?: boolean }> {
  const parsed = ctx.request.body?.() as unknown;
  if (isEnvelopeDocument(parsed)) return { body: parsed };
  const raw = ctx.request.raw?.();
  if (typeof raw === 'string' && raw !== '') return parseEnvelope(raw);
  const stream = ctx.request.request;
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') return {};
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of stream) {
    const buffer = toBuffer(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) return { tooLarge: true };
  return parseEnvelope(Buffer.concat(chunks).toString('utf8'));
}

function isEnvelopeDocument(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)[ENVELOPE_FIELD] === 'string'
  );
}

function parseEnvelope(raw: string): { body?: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return { body: parsed as Record<string, unknown> };
    }
  } catch {
    // Falls through to "no envelope".
  }
  return {};
}
