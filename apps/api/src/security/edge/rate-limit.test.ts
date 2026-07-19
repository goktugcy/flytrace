import { describe, expect, it } from 'bun:test';
import type { Context } from 'hono';
import {
  InMemoryRateLimiter,
  type RateLimitRedis,
  RedisRateLimiter,
  createRateLimiter,
  rateLimitMiddleware,
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

describe('createRateLimiter', () => {
  it('defaults to in-memory', async () => {
    const rl = await createRateLimiter({});
    expect(rl).toBeInstanceOf(InMemoryRateLimiter);
  });

  it('uses redis when configured and a client is supplied', async () => {
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
    const rl = await createRateLimiter({ RATE_LIMIT_BACKEND: 'redis' }, { redis });
    expect(rl).toBeInstanceOf(RedisRateLimiter);
  });

  it('degrades to in-memory when redis backend chosen but no client', async () => {
    const rl = await createRateLimiter({ RATE_LIMIT_BACKEND: 'redis' });
    expect(rl).toBeInstanceOf(InMemoryRateLimiter);
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

  it('sets rate-limit headers and calls next when allowed', async () => {
    const limiter = new InMemoryRateLimiter(() => 0);
    const mw = rateLimitMiddleware({ limiter, keyFn: () => 'k', max: 5, windowMs: 1_000 });
    const { c, headers } = fakeContext();
    let called = false;
    await mw(c, async () => {
      called = true;
    });
    expect(called).toBe(true);
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
  });
});
