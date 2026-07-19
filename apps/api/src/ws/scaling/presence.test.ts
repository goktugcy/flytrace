import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { InMemoryPresence, type PresenceMeta, RedisPresence, createPresence } from './presence.ts';

describe('InMemoryPresence', () => {
  test('join / count / list', async () => {
    const p = new InMemoryPresence();
    await p.join('c1', { uid: 'u1', role: 'user' });
    await p.join('c2', { uid: null, role: 'guest' });
    expect(await p.count()).toBe(2);
    const list = await p.list();
    expect(list.map((e) => e.connId).sort()).toEqual(['c1', 'c2']);
  });

  test('leave removes a connection', async () => {
    const p = new InMemoryPresence();
    await p.join('c1', {});
    await p.leave('c1');
    expect(await p.count()).toBe(0);
  });

  test('entries expire after ttl and are pruned on read', async () => {
    const clock = fixedClock(0);
    const p = new InMemoryPresence({ ttlMs: 1000, clock });
    await p.join('c1', {});
    clock.advance(1500);
    expect(await p.count()).toBe(0);
    expect(await p.list()).toEqual([]);
  });

  test('re-join refreshes the ttl', async () => {
    const clock = fixedClock(0);
    const p = new InMemoryPresence({ ttlMs: 1000, clock });
    await p.join('c1', {});
    clock.advance(800);
    await p.join('c1', {}); // refresh
    clock.advance(800);
    expect(await p.count()).toBe(1);
  });
});

/** Fake ioredis supporting one sorted set + one hash, with multi()/exec. */
function fakePresenceRedis(): Redis {
  const zset = new Map<string, Map<string, number>>();
  const hash = new Map<string, Map<string, string>>();
  const zsetOf = (k: string): Map<string, number> => {
    let m = zset.get(k);
    if (!m) {
      m = new Map();
      zset.set(k, m);
    }
    return m;
  };
  const hashOf = (k: string): Map<string, string> => {
    let m = hash.get(k);
    if (!m) {
      m = new Map();
      hash.set(k, m);
    }
    return m;
  };
  const bound = (s: string): { value: number; exclusive: boolean } => {
    const exclusive = s.startsWith('(');
    const body = exclusive ? s.slice(1) : s;
    const value =
      body === '-inf'
        ? Number.NEGATIVE_INFINITY
        : body === '+inf'
          ? Number.POSITIVE_INFINITY
          : Number(body);
    return { value, exclusive };
  };

  const ops = {
    zadd(key: string, score: number, member: string) {
      zsetOf(key).set(member, score);
    },
    hset(key: string, field: string, value: string) {
      hashOf(key).set(field, value);
    },
    zrem(key: string, ...members: string[]) {
      const z = zsetOf(key);
      for (const m of members) z.delete(m);
    },
    hdel(key: string, ...fields: string[]) {
      const h = hashOf(key);
      for (const f of fields) h.delete(f);
    },
  };

  class Multi {
    private readonly queue: Array<() => void> = [];
    zadd(k: string, s: number, m: string) {
      this.queue.push(() => ops.zadd(k, s, m));
      return this;
    }
    hset(k: string, f: string, v: string) {
      this.queue.push(() => ops.hset(k, f, v));
      return this;
    }
    zrem(k: string, ...m: string[]) {
      this.queue.push(() => ops.zrem(k, ...m));
      return this;
    }
    hdel(k: string, ...f: string[]) {
      this.queue.push(() => ops.hdel(k, ...f));
      return this;
    }
    async exec() {
      for (const fn of this.queue) fn();
      return [];
    }
  }

  const api = {
    multi: () => new Multi(),
    async zrangebyscore(key: string, min: string, max: string) {
      const lo = bound(min);
      const hi = bound(max);
      return [...zsetOf(key)]
        .filter(([, score]) => {
          const geLo = lo.exclusive ? score > lo.value : score >= lo.value;
          const leHi = hi.exclusive ? score < hi.value : score <= hi.value;
          return geLo && leHi;
        })
        .sort((a, b) => a[1] - b[1])
        .map(([m]) => m);
    },
    async zcard(key: string) {
      return zsetOf(key).size;
    },
    async zrange(key: string) {
      return [...zsetOf(key)].sort((a, b) => a[1] - b[1]).map(([m]) => m);
    },
    async hmget(key: string, ...fields: string[]) {
      const h = hashOf(key);
      return fields.map((f) => h.get(f) ?? null);
    },
  };
  return api as unknown as Redis;
}

describe('RedisPresence', () => {
  test('join / count / list round-trips meta', async () => {
    const p = new RedisPresence(fakePresenceRedis(), 'p:');
    const meta: PresenceMeta = { uid: 'u1', role: 'user' };
    await p.join('c1', meta);
    expect(await p.count()).toBe(1);
    const list = await p.list();
    expect(list).toEqual([{ connId: 'c1', meta }]);
  });

  test('leave removes the entry and its meta', async () => {
    const p = new RedisPresence(fakePresenceRedis(), 'p:');
    await p.join('c1', {});
    await p.leave('c1');
    expect(await p.count()).toBe(0);
    expect(await p.list()).toEqual([]);
  });

  test('sweep drops expired entries on read', async () => {
    const clock = fixedClock(0);
    const p = new RedisPresence(fakePresenceRedis(), 'p:', { ttlMs: 1000, clock });
    await p.join('c1', {});
    clock.advance(1500);
    expect(await p.count()).toBe(0);
  });
});

describe('createPresence', () => {
  test('defaults to in-memory', async () => {
    const p = await createPresence();
    expect(p).toBeInstanceOf(InMemoryPresence);
  });

  test('uses redis when requested with a connection', async () => {
    const p = await createPresence({ backend: 'redis', redis: fakePresenceRedis() });
    expect(p).toBeInstanceOf(RedisPresence);
  });

  test('degrades to memory when redis absent', async () => {
    const p = await createPresence({ backend: 'redis' });
    expect(p).toBeInstanceOf(InMemoryPresence);
  });
});
