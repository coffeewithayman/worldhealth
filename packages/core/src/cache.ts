/**
 * Where verbatim upstream responses are kept.
 *
 * Replayability, not performance: a parsing bug found on Tuesday can be fixed
 * and re-run against Monday's exact bytes without burning a free-tier quota.
 * It is deliberately *not* the database — the bodies were ~60% of the SQLite
 * file, are rarely read, and refill themselves, which is the profile of an
 * object store. Implementations: `MemoryCache` and `NullCache` here (no I/O),
 * `FsCache` and `S3Cache` in `@wd/store`, chosen by `WD_CACHE_URL`.
 */
export interface CachedResponse {
  cacheKey: string;
  sourceId: string;
  /** Redacted — never carries the credential the real request did. */
  url: string;
  fetchedAt: string;
  body: string;
}

export interface ResponseCache {
  get(cacheKey: string): Promise<CachedResponse | null>;
  put(entry: CachedResponse): Promise<void>;
  /** Delete entries fetched before `before`. Returns how many went. */
  prune(before: Date): Promise<number>;
  /** Credential-free, for logs and banners. */
  describe(): string;
}

/** Remembers nothing. What `doctor` gets, so "(no writes)" is true. */
export class NullCache implements ResponseCache {
  async get(_cacheKey: string): Promise<CachedResponse | null> { return null; }
  async put(_entry: CachedResponse): Promise<void> {}
  async prune(_before: Date): Promise<number> { return 0; }
  describe(): string { return 'none'; }
}

/** In-process cache for tests. */
export class MemoryCache implements ResponseCache {
  private entries = new Map<string, CachedResponse>();

  async get(cacheKey: string): Promise<CachedResponse | null> {
    const e = this.entries.get(cacheKey);
    return e ? { ...e } : null;
  }

  async put(entry: CachedResponse): Promise<void> {
    this.entries.set(entry.cacheKey, { ...entry });
  }

  async prune(before: Date): Promise<number> {
    let n = 0;
    for (const [k, e] of this.entries) {
      if (new Date(e.fetchedAt) < before) { this.entries.delete(k); n++; }
    }
    return n;
  }

  describe(): string { return 'memory'; }

  /** Cache keys are hashed by `Http`; this is how a test finds what it wrote. */
  keys(): string[] { return [...this.entries.keys()]; }
}
