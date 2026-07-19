/**
 * A tiny TTL cache used to memoize the (potentially expensive) result of a
 * provider load — parsing a large openAIP/AIXM dataset — so repeated loads
 * within the TTL reuse the parsed airspaces instead of re-reading/re-parsing.
 *
 * Injectable clock keeps it deterministically testable. Pure aside from the
 * clock; no external I/O.
 */
export interface TtlCacheOptions {
  /** Time-to-live in milliseconds. `0` disables caching (always misses). */
  ttlMs: number;
  /** Clock source; defaults to Date.now. Override in tests. */
  now?: () => number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
}

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly store = new Map<K, Entry<V>>();

  constructor(opts: TtlCacheOptions) {
    this.ttlMs = Math.max(0, opts.ttlMs);
    this.now = opts.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const hit = this.store.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.ttlMs === 0) return;
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /**
   * Return the cached value for `key`, or compute it with `loader`, cache it,
   * and return it. Concurrent callers for the same key share one in-flight
   * promise so a slow load isn't duplicated (single-flight).
   */
  async getOrLoad(key: K, loader: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  private readonly inflight = new Map<K, Promise<V>>();

  clear(): void {
    this.store.clear();
    this.inflight.clear();
  }
}
