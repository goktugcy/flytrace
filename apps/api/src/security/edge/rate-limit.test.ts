import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import {
  InMemoryRateLimiter,
  type RateLimitRedis,
  RedisRateLimiter,
  rateLimitKey,
  rateLimitMiddleware,
  resolveRateLimiter,
} from './rate-limit.ts';

describe('InMemoryRateLimiter', () => {
  it('allows up to `limit` hits then blocks within the window', async () => {
    const t = 1_000;
    const rl = new InMemoryRateLimiter(() => t);
    expect((await rl.check('k', 2, 10_000)).allowed).toBe(true);
    expect((await rl.check('k', 2, 10_000)).allowed).toBe(true);
    const third = await rl.check('k', 2, 10_000);
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
    expect(third.retryAfterMs).toBe(10_000);
  });

  it('resets once the window elapses', async () => {
    let t = 0;
    const rl = new InMemoryRateLimiter(() => t);
    await rl.check('k', 1, 1_000);
    expect((await rl.check('k', 1, 1_000)).allowed).toBe(false);
    t = 1_000; // window boundary reached
    expect((await rl.check('k', 1, 1_000)).allowed).toBe(true);
  });

  it('isolates counters per key', async () => {
    const rl = new InMemoryRateLimiter(() => 0);
    await rl.check('a', 1, 1_000);
    expect((await rl.check('b', 1, 1_000)).allowed).toBe(true);
  });
});

describe('RedisRateLimiter', () => {
  function fakeRedis(): RateLimitRedis & { store: Map<string, number> } {
    const store = new Map<string, number>();
    return {
      store,
      async incr(key) {
        const n = (store.get(key) ?? 0) + 1;
        store.set(key, n);
        return n;
      },
      async pexpire() {
        return 1;
      },
      async pttl() {
        return 5_000;
      },
    };
  }

  it('blocks once the counter exceeds the limit', async () => {
    const redis = fakeRedis();
    const rl = new RedisRateLimiter(redis, 'rl:', () => 100);
    expect((await rl.check('ip', 1, 5_000)).allowed).toBe(true);
    const blocked = await rl.check('ip', 1, 5_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(5_000);
    expect(blocked.resetAtMs).toBe(5_100);
    expect(redis.store.get('rl:ip')).toBe(2);
  });
});

describe('resolveRateLimiter', () => {
  const redis: RateLimitRedis = {
    async incr() {
      return 1;
    },
    async pexpire() {
      return 1;
    },
    async pttl() {
      return 1_000;
    },
  };

  it('defaults to in-memory outside production', () => {
    expect(resolveRateLimiter({ APP_ENV: 'local' })).toBeInstanceOf(InMemoryRateLimiter);
  });

  it('uses redis when configured and a client is supplied', () => {
    const rl = resolveRateLimiter(
      { RATE_LIMIT_BACKEND: 'redis', APP_ENV: 'production' },
      { redis },
    );
    expect(rl).toBeInstanceOf(RedisRateLimiter);
  });

  it('degrades to in-memory outside production when redis is chosen but absent', () => {
    const warnings: string[] = [];
    const rl = resolveRateLimiter(
      { RATE_LIMIT_BACKEND: 'redis', APP_ENV: 'local' },
      { logger: { warn: (m) => warnings.push(m) } },
    );
    expect(rl).toBeInstanceOf(InMemoryRateLimiter);
    // The fallback must be loud, never silent.
    expect(warnings.join(' ')).toContain('falling back to the in-memory limiter');
  });

  it('refuses to start in production with the memory backend', () => {
    expect(() =>
      resolveRateLimiter({ RATE_LIMIT_BACKEND: 'memory', APP_ENV: 'production' }),
    ).toThrow(/not permitted in production/);
  });

  it('refuses to start in production when redis is chosen but unavailable', () => {
    expect(() =>
      resolveRateLimiter({ RATE_LIMIT_BACKEND: 'redis', APP_ENV: 'production' }),
    ).toThrow(/no Redis client is available/);
  });

  it('rejects an invalid backend value in any environment', () => {
    expect(() => resolveRateLimiter({ RATE_LIMIT_BACKEND: 'memcached', APP_ENV: 'local' })).toThrow(
      /not a valid backend/,
    );
  });
});

describe('rateLimitKey', () => {
  it('hashes user-controlled material so nothing raw reaches Redis', () => {
    const key = rateLimitKey('login', 'id', 'victim@example.com');
    expect(key.startsWith('login:')).toBe(true);
    expect(key).not.toContain('victim@example.com');
    expect(key).toMatch(/^login:[0-9a-f]{32}$/);
  });

  it('cannot be steered by injecting separators into the input', () => {
    const a = rateLimitKey('login', 'a:b');
    const b = rateLimitKey('login', 'a', 'b');
    expect(a).toMatch(/^login:[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('is stable for the same material', () => {
    expect(rateLimitKey('api', '1.2.3.4')).toBe(rateLimitKey('api', '1.2.3.4'));
  });
});

describe('multi-instance behaviour', () => {
  it('two Redis-backed limiters sharing a store enforce ONE shared budget', async () => {
    const store = new Map<string, number>();
    const shared: RateLimitRedis = {
      async incr(key) {
        const n = (store.get(key) ?? 0) + 1;
        store.set(key, n);
        return n;
      },
      async pexpire() {
        return 1;
      },
      async pttl() {
        return 5_000;
      },
    };
    // Simulates two API replicas behind a load balancer.
    const instanceA = new RedisRateLimiter(shared, 'rl:', () => 0);
    const instanceB = new RedisRateLimiter(shared, 'rl:', () => 0);

    expect((await instanceA.check('ip', 2, 5_000)).allowed).toBe(true);
    expect((await instanceB.check('ip', 2, 5_000)).allowed).toBe(true);
    // The third request is blocked no matter which replica serves it.
    expect((await instanceA.check('ip', 2, 5_000)).allowed).toBe(false);
    expect((await instanceB.check('ip', 2, 5_000)).allowed).toBe(false);
  });

  it('two in-memory limiters do NOT share a budget (why production forbids them)', async () => {
    const instanceA = new InMemoryRateLimiter(() => 0);
    const instanceB = new InMemoryRateLimiter(() => 0);
    expect((await instanceA.check('ip', 1, 5_000)).allowed).toBe(true);
    expect((await instanceB.check('ip', 1, 5_000)).allowed).toBe(true);
  });
});

describe('rateLimitMiddleware', () => {
  function fakeContext(): { c: Context; headers: Record<string, string>; jsonCalls: unknown[] } {
    const headers: Record<string, string> = {};
    const jsonCalls: unknown[] = [];
    const c = {
      req: { header: (_n: string) => undefined },
      header: (name: string, value: string) => {
        headers[name] = value;
      },
      json: (body: unknown, status?: number, hdrs?: Record<string, string>) => {
        jsonCalls.push({ body, status, hdrs });
        return { status, body, hdrs } as unknown as Response;
      },
    } as unknown as Context;
    return { c, headers, jsonCalls };
  }

  it('sets standard and legacy rate-limit headers and calls next when allowed', async () => {
    const limiter = new InMemoryRateLimiter(() => 0);
    const mw = rateLimitMiddleware({ limiter, keyFn: () => 'k', max: 5, windowMs: 1_000 });
    const { c, headers } = fakeContext();
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(headers['RateLimit-Limit']).toBe('5');
    expect(headers['RateLimit-Remaining']).toBe('4');
    expect(headers['RateLimit-Reset']).toBeDefined();
    expect(headers['X-RateLimit-Limit']).toBe('5');
    expect(headers['X-RateLimit-Remaining']).toBe('4');
  });

  it('returns 429 with Retry-After when the limit is exceeded', async () => {
    const limiter = new InMemoryRateLimiter(() => 0);
    const mw = rateLimitMiddleware({ limiter, keyFn: () => 'k', max: 1, windowMs: 2_000 });
    const { c } = fakeContext();
    await mw(c, async () => {});
    let calledAgain = false;
    const res = (await mw(c, async () => {
      calledAgain = true;
    })) as unknown as { status: number; hdrs: Record<string, string> };
    expect(calledAgain).toBe(false);
    expect(res.status).toBe(429);
    expect(res.hdrs['Retry-After']).toBe('2');
    expect(res.hdrs['RateLimit-Limit']).toBe('1');
    expect(res.hdrs['RateLimit-Remaining']).toBe('0');
  });

  const brokenLimiter = {
    async check(): Promise<never> {
      throw new Error('redis is down');
    },
  };

  it('fail-open lets the request through when the backend is down', async () => {
    const mw = rateLimitMiddleware({
      limiter: brokenLimiter,
      keyFn: () => 'k',
      max: 1,
      windowMs: 1_000,
      onError: 'fail-open',
    });
    const { c } = fakeContext();
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
  });

  it('fail-closed rejects with 503 when the backend is down', async () => {
    const mw = rateLimitMiddleware({
      limiter: brokenLimiter,
      keyFn: () => 'k',
      max: 1,
      windowMs: 1_000,
      onError: 'fail-closed',
    });
    const { c } = fakeContext();
    let called = false;
    const res = (await mw(c, async () => {
      called = true;
    })) as unknown as { status: number; hdrs: Record<string, string> };
    // A credential endpoint with no working limiter must not serve unlimited
    // guesses.
    expect(called).toBe(false);
    expect(res.status).toBe(503);
    expect(res.hdrs['Retry-After']).toBe('5');
  });
});
