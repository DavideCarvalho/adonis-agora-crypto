/** One unwrapped data key held in memory. */
export interface CachedDataKey {
  id: string;
  /** The subject key that wraps it. */
  key: string;
  /** The 32 key bytes. Zeroed when the entry leaves the cache. */
  bytes: Buffer;
  /** Epoch ms after which the entry is gone (absolute: a hit does not extend it). */
  expiresAt: number;
}

export interface DataKeyCacheOptions {
  /** Most data keys held at once (least recently used goes first). Default `1000`. `0` disables. */
  maxEntries?: number;
  /** How long an unwrapped data key stays in memory, in ms. Default `300000` (5 min). `0` disables. */
  ttlMs?: number;
  /** Clock, so tests can move time. */
  now?: () => number;
}

/**
 * A bounded LRU + absolute-TTL cache of unwrapped data keys, plus each subject's current data key.
 * Every entry that leaves (eviction, expiry, `evictKey`, `clear`) has its bytes overwritten with
 * zeros. The base64url string the control plane answered with cannot be zeroed (JS strings are
 * immutable); it is dropped right after decoding and left to the garbage collector.
 */
export class DataKeyCache {
  readonly maxEntries: number;
  readonly ttlMs: number;
  readonly #now: () => number;
  /** id → entry, in LRU order (oldest first). */
  readonly #entries = new Map<string, CachedDataKey>();
  /** subject key → id of its current data key (always an id present in #entries). */
  readonly #current = new Map<string, string>();

  constructor(options: DataKeyCacheOptions = {}) {
    this.maxEntries = Math.max(0, Math.floor(options.maxEntries ?? 1000));
    this.ttlMs = Math.max(0, options.ttlMs ?? 5 * 60_000);
    this.#now = options.now ?? Date.now;
  }

  get enabled(): boolean {
    return this.maxEntries > 0 && this.ttlMs > 0;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(id: string): CachedDataKey | undefined {
    const entry = this.#entries.get(id);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.#now()) {
      this.#drop(entry);
      return undefined;
    }
    this.#entries.delete(id);
    this.#entries.set(id, entry);
    return entry;
  }

  current(key: string): CachedDataKey | undefined {
    const id = this.#current.get(key);
    return id === undefined ? undefined : this.get(id);
  }

  /**
   * Stores a copy of `bytes` (the caller zeroes its own) and returns another, private copy for the
   * caller to use and zero: the cached buffer itself never leaves the cache.
   */
  set(id: string, key: string, bytes: Buffer, options: { current?: boolean } = {}): Buffer {
    const result = Buffer.from(bytes);
    if (!this.enabled) return result;
    const existing = this.#entries.get(id);
    if (existing) this.#drop(existing);
    const held = Buffer.from(bytes);
    this.#entries.set(id, { id, key, bytes: held, expiresAt: this.#now() + this.ttlMs });
    if (options.current) this.#current.set(key, id);
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.values().next().value as CachedDataKey;
      this.#drop(oldest);
    }
    return result;
  }

  /** Drops (and zeroes) every data key of one subject key. */
  evictKey(key: string): void {
    for (const entry of [...this.#entries.values()]) {
      if (entry.key === key) this.#drop(entry);
    }
    this.#current.delete(key);
  }

  /** Forgets which data key is current for a subject key, keeping the keys for reads. */
  forgetCurrent(key: string): void {
    this.#current.delete(key);
  }

  clear(): void {
    for (const entry of [...this.#entries.values()]) this.#drop(entry);
    this.#current.clear();
  }

  #drop(entry: CachedDataKey): void {
    this.#entries.delete(entry.id);
    if (this.#current.get(entry.key) === entry.id) this.#current.delete(entry.key);
    entry.bytes.fill(0);
  }
}
