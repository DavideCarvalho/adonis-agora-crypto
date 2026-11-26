import {
  assertSealedFor,
  type BatchResult,
  type CreateKeyInput,
  type CryptoAuditRecord,
  type CryptoErrorBody,
  type CryptoErrorCode,
  type CryptoKeyView,
  type CursorPage,
  type DataKeyInput,
  type DataKeyResult,
  type DecryptInput,
  type DecryptResult,
  type EncryptInput,
  type EncryptResult,
  type ExportKeyResult,
  type HasKeyInput,
  type HasKeyResult,
  type HmacInput,
  type HmacResult,
  type KeyPolicyInput,
  type OffsetPage,
  type PublicKeyResult,
  type RewrapInput,
  type RewrapResult,
  type SignInput,
  type SignResult,
  type VerifyInput,
  type VerifyResult,
  type Whoami,
} from './index.js';
import { resolveTenantToken, type TenantToken, type TenantTokenSource } from './token.js';
import { ServerUrl, type ServerUrlSource } from './url.js';

export interface CryptoClientOptions {
  /**
   * The server, including its prefix (`https://crypto.example.com/_crypto`), or a function that
   * resolves it before the first call (`controlPlaneUrl(...)` from `@adonis-agora/authkit-client`).
   * A function is looked up again (its `refresh()` when it has one) after a connection error or a
   * 404 the server did not explain.
   */
  url: ServerUrlSource;
  /** The app (partition); the server derives it from the token, this names it for shared secrets. */
  partition: string;
  /** A shared secret, a function (`authkitTenantToken(...)`), or an object with `get()`. */
  token: TenantTokenSource;
  fetch?: typeof fetch;
  /** Per request. Default `10000`. */
  timeoutMs?: number;
  /** Retries after a network error, a 429 or a 5xx. Default `2`. */
  retries?: number;
  /** Base delay between retries, doubled each time. Default `100`. */
  retryDelayMs?: number;
}

/** A refusal or a failure the server reported, with its wire code. */
export class CryptoClientError extends Error {
  /** A connection error, or a 404 with no crypto error body: the server may have moved. */
  readonly unreachable: boolean;

  constructor(
    readonly status: number,
    readonly code: CryptoErrorCode | 'network' | 'timeout',
    message: string,
    options: { unreachable?: boolean } = {},
  ) {
    super(message);
    this.name = 'CryptoClientError';
    this.unreachable = options.unreachable ?? code === 'network';
  }
}

export interface KeyListQuery {
  /** Free text over the name and the description. */
  search?: string;
  page?: number;
  size?: number;
  /** `name`, `-name`, `createdAt`, `-createdAt`, `updatedAt`, `-updatedAt`. */
  sort?: string;
}

export interface AuditListQuery {
  page?: number;
  size?: number;
  /** `at`, `-at`. */
  sort?: string;
  key?: string;
  operation?: string;
  result?: string;
  actor?: string;
}

/** {@link CryptoClient.auditCursor}: keyset paging over the audit trail, no total. */
export interface AuditCursorListQuery {
  /** A previous page's `meta.nextCursor`: the page after it. */
  after?: string;
  /** A previous page's `meta.prevCursor`: the page before it. */
  before?: string;
  /** Page size. Default 50, at most 200. */
  size?: number;
  /** `at`, `-at`. */
  sort?: string;
  key?: string;
  operation?: string;
  result?: string;
  actor?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A typed client for an `@adonis-agora/crypto` server. No AdonisJS, no filesystem: usable from an
 * app, a script, a worker or a Sail CLI.
 *
 * ```ts
 * const client = createCryptoClient({ url, partition: 'streaming', token })
 * const { ciphertext } = await client.encrypt({ key: 'pii', plaintext: 'x' })
 * const { plaintext } = await client.decrypt({ key: 'pii', ciphertext })
 * ```
 */
export class CryptoClient {
  readonly partition: string;
  readonly #url: ServerUrl;
  readonly #token: TenantToken;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #retryDelayMs: number;

  constructor(options: CryptoClientOptions) {
    if (!options.url) throw new Error('crypto: url is required');
    if (!options.partition) throw new Error('crypto: partition is required');
    this.#url = new ServerUrl(options.url);
    this.partition = options.partition;
    this.#token = resolveTenantToken(options.token);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#retries = options.retries ?? 2;
    this.#retryDelayMs = options.retryDelayMs ?? 100;
  }

  /** The server URL; `''` while a lazy one has not resolved yet (see {@link resolveUrl}). */
  get url(): string {
    return this.#url.current ?? '';
  }

  /** The server URL, resolving a lazy one. */
  resolveUrl(): Promise<string> {
    return this.#url.resolve();
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Transport                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  async #headers(json: boolean): Promise<Record<string, string>> {
    const token = await this.#token.get();
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'x-crypto-app': this.partition,
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  async #once<T>(method: string, path: string, body: unknown, tokenReset: () => void): Promise<T> {
    let base: string;
    try {
      base = await this.#url.resolve();
    } catch (error) {
      throw new CryptoClientError(
        0,
        'network',
        `crypto: could not resolve the server url: ${(error as Error).message}`,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${base}${path}`, {
        method,
        headers: await this.#headers(body !== undefined),
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (response.status === 204) return undefined as T;
      const payload = (await response.json().catch(() => ({}))) as Partial<CryptoErrorBody>;
      if (response.status === 401) {
        tokenReset();
        throw new CryptoClientError(401, 'unauthenticated', 'crypto: the server refused the token');
      }
      if (!response.ok) {
        throw new CryptoClientError(
          response.status,
          (payload.code as CryptoErrorCode | undefined) ?? 'invalid',
          payload.error ?? `crypto: the server answered ${response.status}`,
          // A 404 the server did not explain is a route that is not there: the wrong host.
          { unreachable: response.status === 404 && payload.code === undefined },
        );
      }
      return payload as T;
    } catch (error) {
      if (error instanceof CryptoClientError) throw error;
      if ((error as { name?: string }).name === 'AbortError') {
        throw new CryptoClientError(0, 'timeout', `crypto: ${method} ${path} timed out`);
      }
      throw new CryptoClientError(
        0,
        'network',
        `crypto: ${method} ${path} failed: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let reset = false;
    let refreshed = false;
    const tokenReset = () => {
      reset = true;
      this.#token.reset?.();
    };
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#once<T>(method, path, body, tokenReset);
      } catch (error) {
        const failure = error as CryptoClientError;
        // A lazy URL is looked up again once per call when the server is not where it was; a new
        // URL is worth an immediate try that does not count against the retries.
        if (failure.unreachable && !refreshed && this.#url.lazy) {
          refreshed = true;
          const before = this.#url.current;
          const after = await this.#url.refresh();
          if (after !== undefined && after !== before) {
            attempt -= 1;
            continue;
          }
        }
        if (attempt >= this.#retries) throw failure;
        // A network error, a timeout, a 429 and a 5xx are worth another try; a 401 is worth one
        // with a fresh token (the source was reset above); any other 4xx is final.
        const retriable =
          failure.status === 0 || failure.status === 429 || failure.status >= 500 || reset;
        if (!retriable) throw failure;
        reset = false;
        await sleep(this.#retryDelayMs * 2 ** attempt);
      }
    }
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Operations                                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  async encrypt(input: EncryptInput): Promise<EncryptResult> {
    return assertSealedFor(input, await this.#request<EncryptResult>('POST', '/v1/encrypt', input));
  }

  decrypt(input: DecryptInput): Promise<DecryptResult> {
    return this.#request('POST', '/v1/decrypt', input);
  }

  rewrap(input: RewrapInput): Promise<RewrapResult> {
    return this.#request('POST', '/v1/rewrap', input);
  }

  generateDataKey(input: DataKeyInput): Promise<DataKeyResult> {
    return this.#request('POST', '/v1/datakeys', input);
  }

  sign(input: SignInput): Promise<SignResult> {
    return this.#request('POST', '/v1/sign', input);
  }

  verify(input: VerifyInput): Promise<VerifyResult> {
    return this.#request('POST', '/v1/verify', input);
  }

  hmac(input: HmacInput): Promise<HmacResult> {
    return this.#request('POST', '/v1/hmac', input);
  }

  encryptBatch(inputs: readonly EncryptInput[]): Promise<BatchResult<EncryptResult>> {
    return this.#request('POST', '/v1/encrypt/batch', { items: inputs });
  }

  decryptBatch(inputs: readonly DecryptInput[]): Promise<BatchResult<DecryptResult>> {
    return this.#request('POST', '/v1/decrypt/batch', { items: inputs });
  }

  signBatch(inputs: readonly SignInput[]): Promise<BatchResult<SignResult>> {
    return this.#request('POST', '/v1/sign/batch', { items: inputs });
  }

  verifyBatch(inputs: readonly VerifyInput[]): Promise<BatchResult<VerifyResult>> {
    return this.#request('POST', '/v1/verify/batch', { items: inputs });
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Keys and audit                                                                              */
  /* ------------------------------------------------------------------------------------------ */

  #query(params: Record<string, string | number | undefined>): string {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === '') continue;
      query.set(name, String(value));
    }
    const text = query.toString();
    return text === '' ? '' : `?${text}`;
  }

  async listKeys(query: KeyListQuery = {}): Promise<OffsetPage<CryptoKeyView>> {
    return this.#request(
      'GET',
      `/v1/keys${this.#query({
        search: query.search,
        page: query.page ?? 1,
        size: query.size ?? 50,
        sort: query.sort,
      })}`,
    );
  }

  getKey(name: string): Promise<CryptoKeyView> {
    return this.#request('GET', `/v1/keys/${encodeURIComponent(name)}`);
  }

  createKey(input: CreateKeyInput): Promise<CryptoKeyView> {
    return this.#request('POST', '/v1/keys', input);
  }

  rotateKey(name: string): Promise<CryptoKeyView> {
    return this.#request('POST', `/v1/keys/${encodeURIComponent(name)}/rotate`, {});
  }

  updateKeyPolicy(name: string, input: KeyPolicyInput): Promise<CryptoKeyView> {
    return this.#request('PATCH', `/v1/keys/${encodeURIComponent(name)}`, input);
  }

  deleteKey(name: string): Promise<{ key: string; deleted: boolean }> {
    return this.#request('DELETE', `/v1/keys/${encodeURIComponent(name)}`);
  }

  exportKey(name: string, version?: number): Promise<ExportKeyResult> {
    return this.#request(
      'GET',
      `/v1/keys/${encodeURIComponent(name)}/export${this.#query({ version })}`,
    );
  }

  /**
   * Whether `key` exists (and is not deleted) in this client's own partition. Same authorization
   * as `decrypt` on it (an app's own `console-*` keys need no grant); a missing key is `false`, and
   * nothing is written to the audit trail. A server that predates it answers an error: fall back
   * to a decrypt probe.
   */
  async hasKey(input: HasKeyInput): Promise<boolean> {
    const result = await this.#request<HasKeyResult>('POST', '/v1/has-key', input);
    return result?.exists === true;
  }

  publicKey(name: string): Promise<PublicKeyResult> {
    return this.#request('GET', `/v1/keys/${encodeURIComponent(name)}/public`);
  }

  audit(query: AuditListQuery = {}): Promise<OffsetPage<CryptoAuditRecord>> {
    // The list wire format of every Agora endpoint: `filter[field]=value`.
    return this.#request(
      'GET',
      `/v1/audit${this.#query({
        page: query.page ?? 1,
        size: query.size ?? 50,
        sort: query.sort ?? '-at',
        'filter[key]': query.key,
        'filter[operation]': query.operation,
        'filter[result]': query.result,
        'filter[actor]': query.actor,
      })}`,
    );
  }

  /**
   * The audit trail by cursor: cheap at any depth (no count, no offset). Walk it with
   * `meta.nextCursor` → `after`.
   */
  auditCursor(query: AuditCursorListQuery = {}): Promise<CursorPage<CryptoAuditRecord>> {
    const size = query.size ?? 50;
    const backward = query.after === undefined && query.before !== undefined;
    return this.#request(
      'GET',
      `/v1/audit${this.#query({
        after: query.after,
        before: backward ? query.before : undefined,
        first: backward ? undefined : size,
        last: backward ? size : undefined,
        sort: query.sort ?? '-at',
        'filter[key]': query.key,
        'filter[operation]': query.operation,
        'filter[result]': query.result,
        'filter[actor]': query.actor,
      })}`,
    );
  }

  whoami(): Promise<Whoami> {
    return this.#request('GET', '/v1/whoami');
  }
}

/** A client, without a request yet. */
export function createCryptoClient(options: CryptoClientOptions): CryptoClient {
  return new CryptoClient(options);
}
