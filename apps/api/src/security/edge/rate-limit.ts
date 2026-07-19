/**
 * HTTP rate limiting behind a small port. The DEFAULT adapter is an in-memory
 * fixed-window counter (zero external services, deterministic via an injectable
 * clock); a Redis-backed adapter is env-gated for multi-instance deployments
 * and degrades to in-memory when no client is wired.
 */
import { type AdapterFactory, AppError, selectAdapter } from '@flytrace/shared';
import type { Context, MiddlewareHandler } from 'hono';

export interface RateLimitResult {
  allowed: boolean;
  /** Requests remaining in the current window (never negative). */
  remaining: number;
  limit: number;
  /** Milliseconds until the window resets (0 when allowed). */
  retryAfterMs: number;
  /** Epoch ms at which the current window resets. */
  resetAtMs: number;
}

export interface RateLimiter {
  /** Count one hit for `key`; report whether it is within `limit`/`windowMs`. */
  check(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
}

/**
 * Single-process fixed-window limiter. State lives in a Map keyed by request
 * identity; each key's window resets once its deadline passes. `now` is
 * injectable so tests can advance time without real waits.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const t = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= t) {
      window = { count: 0, resetAt: t + windowMs };
      this.windows.set(key, window);
    }
    window.count += 1;
    const allowed = window.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - window.count),
      limit,
      retryAfterMs: allowed ? 0 : window.resetAt - t,
      resetAtMs: window.resetAt,
    };
  }

  /** Test/ops helper: drop all counters. */
  reset(): void {
    this.windows.clear();
  }
}

/**
 * Minimal Redis surface the limiter needs — satisfied by ioredis and trivially
 * faked in tests. Kept narrow so this module never imports ioredis directly.
 */
export interface RateLimitRedis {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

/**
 * Distributed fixed-window limiter: `INCR` the counter, set the window TTL on
 * first hit, and use the remaining TTL as the retry hint. Shared across API
 * instances so a client can't fan out to dodge the limit.
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: RateLimitRedis,
    private readonly prefix = 'rl:',
    private readonly now: () => number = Date.now,
  ) {}

  async check(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const k = this.prefix + key;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.pexpire(k, windowMs);
    let ttl = await this.redis.pttl(k);
    if (ttl < 0) ttl = windowMs; // key had no expiry (edge) — treat as full window
    const allowed = count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - count),
      limit,
      retryAfterMs: allowed ? 0 : ttl,
      resetAtMs: this.now() + ttl,
    };
  }
}

export interface RateLimitConfig {
  RATE_LIMIT_BACKEND?: string | undefined;
}

export interface RateLimitFactoryDeps {
  redis?: RateLimitRedis | undefined;
  now?: (() => number) | undefined;
  prefix?: string | undefined;
  logger?:
    | {
        warn: (msg: string, meta?: unknown) => void;
        info?: (msg: string, meta?: unknown) => void;
      }
    | undefined;
}

/**
 * Build the configured limiter. `RATE_LIMIT_BACKEND=redis` selects the Redis
 * adapter when a client is supplied; anything else (or a missing client) falls
 * back to in-memory so local dev always boots.
 */
export function createRateLimiter(
  cfg: RateLimitConfig,
  deps: RateLimitFactoryDeps = {},
): Promise<RateLimiter> {
  const now = deps.now ?? Date.now;
  const prefix = deps.prefix ?? 'rl:';
  const adapters: Record<string, AdapterFactory<RateLimiter>> = {
    memory: () => new InMemoryRateLimiter(now),
    redis: () =>
      deps.redis ? new RedisRateLimiter(deps.redis, prefix, now) : new InMemoryRateLimiter(now),
  };
  return selectAdapter({
    label: 'rate-limit',
    kind: cfg.RATE_LIMIT_BACKEND,
    adapters,
    fallback: 'memory',
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}

export interface RateLimitMiddlewareOptions {
  limiter: RateLimiter;
  /** Derive the bucket key from the request (e.g. client IP, or IP+route). */
  keyFn: (c: Context) => string;
  max: number;
  windowMs: number;
}

/**
 * Hono middleware enforcing a rate limit. Sets `X-RateLimit-*` headers on every
 * response and, when the limit is exceeded, short-circuits with 429 + a
 * `Retry-After` header (seconds) plus the standard AppError envelope body.
 */
export function rateLimitMiddleware(opts: RateLimitMiddlewareOptions): MiddlewareHandler {
  const { limiter, keyFn, max, windowMs } = opts;
  return async (c, next) => {
    const result = await limiter.check(keyFn(c), max, windowMs);
    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      const requestId = c.req.header('x-request-id');
      const err = new AppError('RATE_LIMITED', 'too many requests', {
        details: { retryAfterMs: result.retryAfterMs },
      });
      return c.json(err.toEnvelope(requestId), 429, {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
      });
    }
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    await next();
    return undefined;
  };
}
