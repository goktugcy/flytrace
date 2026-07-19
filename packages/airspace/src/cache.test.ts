import { describe, expect, test } from 'bun:test';
import { TtlCache } from './cache.ts';

describe('TtlCache', () => {
  test('get returns undefined on miss, value after set', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1000, now: () => 0 });
    expect(c.get('k')).toBeUndefined();
    c.set('k', 42);
    expect(c.get('k')).toBe(42);
  });

  test('entries expire after the TTL', () => {
    let now = 0;
    const c = new TtlCache<string, number>({ ttlMs: 1000, now: () => now });
    c.set('k', 42);
    now = 999;
    expect(c.get('k')).toBe(42);
    now = 1000; // expiresAt <= now → expired
    expect(c.get('k')).toBeUndefined();
  });

  test('ttlMs=0 disables caching (always misses)', () => {
    const c = new TtlCache<string, number>({ ttlMs: 0, now: () => 0 });
    c.set('k', 42);
    expect(c.get('k')).toBeUndefined();
  });

  test('getOrLoad computes on miss and reuses on hit', async () => {
    let now = 0;
    let calls = 0;
    const c = new TtlCache<string, number>({ ttlMs: 1000, now: () => now });
    const load = async () => {
      calls += 1;
      return 7;
    };
    expect(await c.getOrLoad('k', load)).toBe(7);
    expect(await c.getOrLoad('k', load)).toBe(7);
    expect(calls).toBe(1);
    now = 2000;
    expect(await c.getOrLoad('k', load)).toBe(7);
    expect(calls).toBe(2);
  });

  test('getOrLoad is single-flight for concurrent callers', async () => {
    let calls = 0;
    const c = new TtlCache<string, number>({ ttlMs: 1000, now: () => 0 });
    const load = async () => {
      calls += 1;
      await Promise.resolve();
      return 5;
    };
    const [a, b] = await Promise.all([c.getOrLoad('k', load), c.getOrLoad('k', load)]);
    expect(a).toBe(5);
    expect(b).toBe(5);
    expect(calls).toBe(1);
  });

  test('clear drops cached entries', () => {
    const c = new TtlCache<string, number>({ ttlMs: 1000, now: () => 0 });
    c.set('k', 1);
    c.clear();
    expect(c.get('k')).toBeUndefined();
  });
});
