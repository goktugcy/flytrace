import { describe, expect, it } from 'bun:test';
import { AppError, fixedClock, hashToken, isAppError } from '@flytrace/shared';
import {
  InMemoryMfaChallengeStore,
  type MfaChallengeRedis,
  MfaChallengeService,
  RedisMfaChallengeStore,
  resolveMfaChallengeStore,
} from './challenge.ts';

function makeService(opts: { ttlMs?: number; maxAttempts?: number } = {}) {
  const clock = fixedClock(1_000_000);
  const store = new InMemoryMfaChallengeStore(() => clock.now());
  const service = new MfaChallengeService({
    store,
    clock,
    ttlMs: opts.ttlMs ?? 300_000,
    maxAttempts: opts.maxAttempts ?? 3,
  });
  return { clock, store, service };
}

describe('MfaChallengeService.issue', () => {
  it('returns a high-entropy token and stores only its digest as the key', async () => {
    const { service, store } = makeService();
    const challenge = await service.issue('user-1');

    expect(challenge.token).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.expiresInSeconds).toBe(300);
    // The raw token is not a key; its digest is.
    expect(await store.get(challenge.token)).toBeNull();
    expect((await store.get(hashToken(challenge.token)))?.userId).toBe('user-1');
  });

  it('clamps the TTL into the 1–10 minute band', () => {
    const clock = fixedClock(0);
    const store = new InMemoryMfaChallengeStore(() => clock.now());
    const tooShort = new MfaChallengeService({ store, clock, ttlMs: 1_000, maxAttempts: 5 });
    const tooLong = new MfaChallengeService({ store, clock, ttlMs: 3_600_000, maxAttempts: 5 });
    expect(tooShort.challengeTtlMs).toBe(60_000);
    expect(tooLong.challengeTtlMs).toBe(600_000);
  });
});

describe('MfaChallengeService.complete', () => {
  it('runs the verifier for the challenge owner and consumes on success', async () => {
    const { service, store } = makeService();
    const { token } = await service.issue('user-1');

    const seen: string[] = [];
    const result = await service.complete(token, async (userId) => {
      seen.push(userId);
      return 'totp';
    });

    expect(seen).toEqual(['user-1']);
    expect(result).toEqual({ userId: 'user-1', result: 'totp' });
    expect(store.size()).toBe(0);
  });

  it('is single use', async () => {
    const { service } = makeService();
    const { token } = await service.issue('user-1');
    await service.complete(token, async () => 'totp');

    const err = await service.complete(token, async () => 'totp').catch((e) => e);
    expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an expired challenge and removes it', async () => {
    const { service, clock, store } = makeService({ ttlMs: 60_000 });
    const { token } = await service.issue('user-1');
    clock.advance(60_001);

    let verifierRan = false;
    const err = await service
      .complete(token, async () => {
        verifierRan = true;
        return 'totp';
      })
      .catch((e) => e);

    expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
    expect(verifierRan).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('rejects an unknown token with the same message as an expired one', async () => {
    const { service, clock } = makeService({ ttlMs: 60_000 });
    const { token } = await service.issue('user-1');
    clock.advance(60_001);

    const expired = await service.complete(token, async () => 'totp').catch((e) => e);
    const unknown = await service.complete('deadbeef', async () => 'totp').catch((e) => e);
    expect((expired as Error).message).toBe((unknown as Error).message);
  });

  it('refuses a challenge belonging to another user and burns it', async () => {
    const { service, store } = makeService();
    const { token } = await service.issue('victim');

    const err = await service.complete(token, async () => 'totp', 'attacker').catch((e) => e);
    expect(isAppError(err) && err.code).toBe('UNAUTHENTICATED');
    // Probing another user's challenge destroys it rather than leaving it live.
    expect(store.size()).toBe(0);
  });

  it('keeps the challenge usable after a failed verification', async () => {
    const { service, store } = makeService({ maxAttempts: 3 });
    const { token } = await service.issue('user-1');

    await expect(
      service.complete(token, async () => {
        throw new AppError('UNAUTHENTICATED', 'invalid MFA code');
      }),
    ).rejects.toBeInstanceOf(AppError);

    expect(store.size()).toBe(1);
    await expect(service.complete(token, async () => 'totp')).resolves.toBeDefined();
  });

  it('burns the challenge after too many failed attempts', async () => {
    const { service, store } = makeService({ maxAttempts: 2 });
    const { token } = await service.issue('user-1');
    const fail = () =>
      service.complete(token, async () => {
        throw new AppError('UNAUTHENTICATED', 'invalid MFA code');
      });

    await expect(fail()).rejects.toBeInstanceOf(AppError);
    await expect(fail()).rejects.toBeInstanceOf(AppError);

    const limited = await fail().catch((e) => e);
    expect(isAppError(limited) && limited.code).toBe('RATE_LIMITED');
    expect(store.size()).toBe(0);

    // The correct code cannot revive a burned challenge either.
    const after = await service.complete(token, async () => 'totp').catch((e) => e);
    expect(isAppError(after) && after.code).toBe('UNAUTHENTICATED');
  });

  it('serialises concurrent verifications of one challenge', async () => {
    const { service } = makeService();
    const { token } = await service.issue('user-1');

    let concurrent = 0;
    let maxConcurrent = 0;
    const verify = async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent -= 1;
      return 'totp' as const;
    };

    const [a, b] = await Promise.allSettled([
      service.complete(token, verify),
      service.complete(token, verify),
    ]);

    // Exactly one wins; the loser is rejected rather than double-spending a
    // backup code.
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(maxConcurrent).toBe(1);
  });

  it('discard() drops a challenge without completing it', async () => {
    const { service, store } = makeService();
    const { token } = await service.issue('user-1');
    await service.discard(token);
    expect(store.size()).toBe(0);
  });
});

describe('RedisMfaChallengeStore', () => {
  function fakeRedis() {
    const hashes = new Map<string, Record<string, string>>();
    const strings = new Map<string, string>();
    const redis: MfaChallengeRedis = {
      async hset(key, values) {
        hashes.set(key, { ...(hashes.get(key) ?? {}), ...values });
        return 1;
      },
      async hgetall(key) {
        return hashes.get(key) ?? {};
      },
      async hincrby(key, field, increment) {
        const row = hashes.get(key) ?? {};
        const next = Number(row[field] ?? 0) + increment;
        hashes.set(key, { ...row, [field]: String(next) });
        return next;
      },
      async pexpire() {
        return 1;
      },
      async del(key) {
        return hashes.delete(key) ? 1 : 0;
      },
      async set(key, value, _mode, _ttl, _cond) {
        if (strings.has(key)) return null;
        strings.set(key, value);
        return 'OK';
      },
      async eval(_script, _n, key, fence) {
        if (strings.get(key as string) === fence) {
          strings.delete(key as string);
          return 1;
        }
        return 0;
      },
    };
    return { redis, hashes, strings };
  }

  it('namespaces keys by prefix and never stores the raw token', async () => {
    const { redis, hashes } = fakeRedis();
    const store = new RedisMfaChallengeStore(redis, 'flytrace:prod:');
    const id = hashToken('the-raw-token');
    await store.create(id, { userId: 'u1', attempts: 0, expiresAtMs: 5_000 }, 60_000);

    const keys = [...hashes.keys()];
    expect(keys).toEqual([`flytrace:prod:mfa:chal:${id}`]);
    expect(JSON.stringify([...hashes.entries()])).not.toContain('the-raw-token');
  });

  it('consume() reports true only for the caller that removed the key', async () => {
    const { redis } = fakeRedis();
    const store = new RedisMfaChallengeStore(redis, 'p:');
    await store.create('id', { userId: 'u1', attempts: 0, expiresAtMs: 5_000 }, 60_000);
    expect(await store.consume('id')).toBe(true);
    expect(await store.consume('id')).toBe(false);
  });

  it('acquireLock() is exclusive and releases with a fenced delete', async () => {
    const { redis } = fakeRedis();
    const store = new RedisMfaChallengeStore(redis, 'p:');
    const first = await store.acquireLock('id', 10_000);
    expect(first).not.toBeNull();
    expect(await store.acquireLock('id', 10_000)).toBeNull();
    await first?.();
    expect(await store.acquireLock('id', 10_000)).not.toBeNull();
  });

  it('recordAttempt() returns null for a challenge that is gone', async () => {
    const { redis } = fakeRedis();
    const store = new RedisMfaChallengeStore(redis, 'p:');
    expect(await store.recordAttempt('missing')).toBeNull();
  });
});

describe('resolveMfaChallengeStore', () => {
  const redisStub = {} as MfaChallengeRedis;

  it('uses Redis when configured and available', () => {
    const store = resolveMfaChallengeStore(
      { MFA_CHALLENGE_BACKEND: 'redis', APP_ENV: 'production' },
      { redis: redisStub, prefix: 'p:' },
    );
    expect(store).toBeInstanceOf(RedisMfaChallengeStore);
  });

  it('refuses the memory backend in production', () => {
    expect(() =>
      resolveMfaChallengeStore({ MFA_CHALLENGE_BACKEND: 'memory', APP_ENV: 'production' }),
    ).toThrow(/not permitted in production/);
  });

  it('refuses to start in production when Redis is unavailable', () => {
    expect(() =>
      resolveMfaChallengeStore({ MFA_CHALLENGE_BACKEND: 'redis', APP_ENV: 'production' }),
    ).toThrow(/refusing to start/);
  });

  it('falls back to memory outside production, loudly', () => {
    const warnings: string[] = [];
    const store = resolveMfaChallengeStore(
      { MFA_CHALLENGE_BACKEND: 'redis', APP_ENV: 'local' },
      { logger: { warn: (m) => warnings.push(m), info: () => {} } },
    );
    expect(store).toBeInstanceOf(InMemoryMfaChallengeStore);
    expect(warnings.join(' ')).toContain('falling back to the in-memory store');
  });
});
