/**
 * The console's wire client. Same-origin only, JSON, CSRF echoed from the XSRF-TOKEN cookie, and
 * the list envelopes follow `_1x/LIST-API-SPEC.md` (`{ data, meta }`).
 *
 * The console never asks for key material or plaintext: every call here returns metadata, and
 * there is no export call at all.
 */

export type KeyType = 'aes256-gcm' | 'x25519' | 'ed25519' | 'hmac-sha256';

export interface KeyVersion {
  version: number;
  createdAt: string;
  createdBy: string;
  kid?: string;
  publicKey?: { crv: string; x: string; kid: string };
  status: 'latest' | 'decryptable' | 'retired';
}

export interface Key {
  partition: string;
  name: string;
  type: KeyType;
  description?: string;
  latestVersion: number;
  minDecryptionVersion: number;
  deletionAllowed: boolean;
  exportable: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt?: string;
  updatedBy?: string;
  deletedAt?: string;
  versions: KeyVersion[];
}

export interface OffsetMeta {
  total: number;
  perPage: number;
  currentPage: number;
  lastPage: number;
  firstPage: number;
}

export interface Page<T> {
  data: T[];
  meta: OffsetMeta;
}

export interface AuditRow {
  id: string;
  at: string;
  partition: string;
  key?: string;
  version?: number;
  operation: string;
  actor: string;
  clientId?: string;
  result: 'ok' | 'denied' | 'error';
  error?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface Overview {
  partition: string;
  keys: number;
  versions: number;
  operations24h: number;
  denied24h: number;
  errors24h: number;
  lastOperationAt?: string;
}

export interface Meta {
  apps: string[];
  defaultPartition: string;
  topology: 'standalone' | 'control-plane';
  actor: string;
  keyTypes: KeyType[];
  capabilityLegend: string[];
}

export interface KeyInput {
  name?: string;
  type?: KeyType;
  description?: string | null;
  deletionAllowed?: boolean;
  exportable?: boolean;
  minDecryptionVersion?: number;
  partition?: string;
}

export interface ConsoleBootstrap {
  base: string;
  api: string;
  app?: string;
  viewer?: { label: string; email?: string; role?: string };
  signOut?: { action: string; csrfToken?: string } | { href: string };
  switcher?: { endpoint: string; others: number };
  search?: { endpoint: string };
}

/** A response the console can show: the HTTP status and the API's own message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]+)/.exec(document.cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

export class CryptoApi {
  constructor(
    readonly base: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = csrfToken();
    if (token !== undefined && method !== 'GET') headers['x-xsrf-token'] = token;
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new ApiError(response.status, payload.error ?? response.statusText);
    }
    return payload as T;
  }

  #query(partition: string, extra: Record<string, string | number | undefined> = {}): string {
    const query = new URLSearchParams({ partition });
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) continue;
      query.set(name, String(value));
    }
    return query.toString();
  }

  meta(): Promise<Meta> {
    return this.#request('GET', '/meta');
  }

  overview(partition: string): Promise<Overview> {
    return this.#request('GET', `/overview?${this.#query(partition)}`);
  }

  keys(
    partition: string,
    options: { search?: string; page?: number; size?: number; sort?: string } = {},
  ): Promise<Page<Key>> {
    return this.#request(
      'GET',
      `/keys?${this.#query(partition, {
        page: options.page ?? 1,
        size: options.size ?? 50,
        sort: options.sort ?? 'name',
        search: options.search,
      })}`,
    );
  }

  key(partition: string, name: string): Promise<Key> {
    return this.#request('GET', `/keys/${encodeURIComponent(name)}?${this.#query(partition)}`);
  }

  createKey(partition: string, input: KeyInput): Promise<Key> {
    return this.#request('POST', `/keys?${this.#query(partition)}`, input);
  }

  rotateKey(partition: string, name: string): Promise<Key> {
    return this.#request(
      'POST',
      `/keys/${encodeURIComponent(name)}/rotate?${this.#query(partition)}`,
      {},
    );
  }

  updateKey(partition: string, name: string, input: KeyInput): Promise<Key> {
    return this.#request(
      'PATCH',
      `/keys/${encodeURIComponent(name)}?${this.#query(partition)}`,
      input,
    );
  }

  deleteKey(partition: string, name: string): Promise<{ key: string; deleted: boolean }> {
    return this.#request('DELETE', `/keys/${encodeURIComponent(name)}?${this.#query(partition)}`);
  }

  audit(
    partition: string,
    options: {
      page?: number;
      size?: number;
      key?: string;
      operation?: string;
      result?: string;
    } = {},
  ): Promise<Page<AuditRow>> {
    return this.#request(
      'GET',
      `/audit?${this.#query(partition, {
        page: options.page ?? 1,
        size: options.size ?? 50,
        sort: '-at',
        'filter[key]': options.key,
        'filter[operation]': options.operation,
        'filter[result]': options.result,
      })}`,
    );
  }
}

/** The JSON data block the crypto server injects into `index.html`. */
export function readBootstrap(elementId = 'crypto-dashboard-config'): ConsoleBootstrap | null {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(elementId);
  if (element === null) return null;
  try {
    const parsed = JSON.parse(element.textContent ?? '') as Partial<ConsoleBootstrap>;
    if (typeof parsed.base !== 'string' || typeof parsed.api !== 'string') return null;
    return parsed as ConsoleBootstrap;
  } catch {
    return null;
  }
}
