import type { HttpClient, ProviderCache, RateLimiter } from '@flytrace/providers';
import type { Redis } from 'ioredis';

/** Redis-backed provider cache (docs/08 §8.8, docs/09 §9.3). */
export class RedisProviderCache implements ProviderCache {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
  ) {}
  async get(key: string): Promise<string | null> {
    return this.redis.get(`${this.prefix}${key}`);
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.redis.set(`${this.prefix}${key}`, value, 'PX', ttlMs);
  }
}

/**
 * Distributed fixed-window rate limiter (docs/08 §8.8): shared across worker
 * replicas via Redis so one budget is honored. A token-bucket refinement can
 * replace the window later without touching callers.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly opts: { limit: number; windowMs: number },
  ) {}
  async tryAcquire(key: string): Promise<boolean> {
    const k = `${this.prefix}${key}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, this.opts.windowMs);
    return count <= this.opts.limit;
  }
}

/** fetch-based HTTP client with an explicit timeout (docs/08 politeness). */
export class FetchHttpClient implements HttpClient {
  async getJson(
    url: string,
    opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': 'FlyTrace/1.0 (+ops@flytrace.local)',
          ...opts.headers,
        },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`http ${res.status}`);
      if (res.status === 204) return null;
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
