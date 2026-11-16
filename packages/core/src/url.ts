/**
 * Where a tenant finds its crypto server: a fixed URL, or a function resolved before the first call
 * (`controlPlaneUrl({ issuer, resource: 'urn:agora:crypto' })` from `@adonis-agora/authkit-client`,
 * read structurally: this package never imports it). A function may carry `refresh()`, called when
 * the server stops answering in case it moved; without it the function itself is called again.
 */
export type ServerUrlSource = string | ((() => Promise<string>) & { refresh?(): Promise<string> });

/** Whether `value` is a usable URL source: an absolute http(s) URL, or a function. */
export function isServerUrlSource(value: unknown): value is ServerUrlSource {
  return typeof value === 'function' || isHttpUrl(value);
}

/** Whether `value` is an absolute http(s) URL. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalize(url: unknown): string {
  if (!isHttpUrl(url)) {
    throw new Error(
      `crypto: the server url must resolve to an absolute http(s) URL (got ${JSON.stringify(url)})`,
    );
  }
  return url.replace(/\/$/, '');
}

/**
 * One server URL, resolved at most once until {@link ServerUrl.refresh} runs. Concurrent callers
 * share one resolution; a failed one is not cached, so the next call tries again.
 */
export class ServerUrl {
  readonly #source: ServerUrlSource;
  #value: string | undefined;
  #pending: Promise<string> | undefined;

  constructor(source: ServerUrlSource) {
    if (typeof source !== 'function' && typeof source !== 'string') {
      throw new Error('crypto: url must be a string or a function');
    }
    this.#source = source;
    if (typeof source === 'string') this.#value = normalize(source);
  }

  /** Whether the URL comes from a function (it can be refreshed). */
  get lazy(): boolean {
    return typeof this.#source === 'function';
  }

  /** The resolved URL, or `undefined` before a lazy one first resolves. */
  get current(): string | undefined {
    return this.#value;
  }

  /** The URL, resolving a lazy one on first use. */
  resolve(): Promise<string> {
    if (this.#value !== undefined) return Promise.resolve(this.#value);
    return this.#run(() => (this.#source as () => Promise<string>)());
  }

  /**
   * Looks a lazy URL up again (with its `refresh()` when it has one). Answers the new URL, or
   * `undefined` for a fixed URL or a failed lookup (the URL already known is kept).
   */
  async refresh(): Promise<string | undefined> {
    const source = this.#source;
    if (typeof source === 'string') return undefined;
    try {
      return await this.#run(() =>
        typeof source.refresh === 'function' ? source.refresh() : source(),
      );
    } catch {
      return undefined;
    }
  }

  #run(lookup: () => Promise<string>): Promise<string> {
    if (this.#pending) return this.#pending;
    const pending = (async () => {
      const url = normalize(await lookup());
      this.#value = url;
      return url;
    })();
    this.#pending = pending;
    const clear = () => {
      if (this.#pending === pending) this.#pending = undefined;
    };
    pending.then(clear, clear);
    return pending;
  }
}
