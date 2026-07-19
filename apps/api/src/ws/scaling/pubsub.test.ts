import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { InMemoryPubSub, RedisPubSub, createPubSub } from './pubsub.ts';

describe('InMemoryPubSub', () => {
  test('delivers a published message to a subscriber', async () => {
    const bus = new InMemoryPubSub();
    const got: Array<[string, string]> = [];
    await bus.subscribe('c1', (ch, msg) => got.push([ch, msg]));
    await bus.publish('c1', 'hello');
    expect(got).toEqual([['c1', 'hello']]);
  });

  test('scopes delivery to the matching channel', async () => {
    const bus = new InMemoryPubSub();
    let hits = 0;
    await bus.subscribe('a', () => hits++);
    await bus.publish('b', 'x');
    expect(hits).toBe(0);
  });

  test('applies the prefix to channels', async () => {
    const bus = new InMemoryPubSub('flytrace:test:');
    const seen: string[] = [];
    await bus.subscribe('c', (ch) => seen.push(ch));
    await bus.publish('c', 'm');
    expect(seen).toEqual(['flytrace:test:c']);
  });

  test('unsub stops delivery', async () => {
    const bus = new InMemoryPubSub();
    let hits = 0;
    const unsub = await bus.subscribe('c', () => hits++);
    await bus.publish('c', '1');
    await unsub();
    await bus.publish('c', '2');
    expect(hits).toBe(1);
  });

  test('close silences further publishes', async () => {
    const bus = new InMemoryPubSub();
    let hits = 0;
    await bus.subscribe('c', () => hits++);
    await bus.close();
    await bus.publish('c', 'x');
    expect(hits).toBe(0);
  });
});

/** Minimal in-process ioredis stand-in wired as pub + duplicate() subscriber. */
function fakeRedisPair(): Redis {
  const subscribers = new Set<FakeRedis>();

  class FakeRedis {
    readonly subscribed = new Set<string>();
    private readonly listeners = new Set<(ch: string, msg: string) => void>();

    duplicate(): FakeRedis {
      const sub = new FakeRedis();
      subscribers.add(sub);
      return sub;
    }
    on(event: string, fn: (ch: string, msg: string) => void): this {
      if (event === 'message') this.listeners.add(fn);
      return this;
    }
    async subscribe(ch: string): Promise<number> {
      this.subscribed.add(ch);
      return this.subscribed.size;
    }
    async unsubscribe(ch: string): Promise<number> {
      this.subscribed.delete(ch);
      return this.subscribed.size;
    }
    async publish(ch: string, msg: string): Promise<number> {
      let n = 0;
      for (const sub of subscribers) {
        if (!sub.subscribed.has(ch)) continue;
        for (const fn of sub.listeners) {
          fn(ch, msg);
          n += 1;
        }
      }
      return n;
    }
    disconnect(): void {
      subscribers.delete(this);
    }
  }

  return new FakeRedis() as unknown as Redis;
}

describe('RedisPubSub', () => {
  test('round-trips publish→subscribe through the fake broker', async () => {
    const bus = new RedisPubSub(fakeRedisPair(), 'flytrace:test:');
    const got: Array<[string, string]> = [];
    await bus.subscribe('shard:1', (ch, msg) => got.push([ch, msg]));
    await bus.publish('shard:1', 'pos');
    expect(got).toEqual([['flytrace:test:shard:1', 'pos']]);
  });

  test('shares one SUBSCRIBE per channel across handlers, unsub is refcounted', async () => {
    const redis = fakeRedisPair();
    const bus = new RedisPubSub(redis, '');
    let a = 0;
    let b = 0;
    const unsubA = await bus.subscribe('c', () => a++);
    await bus.subscribe('c', () => b++);
    await bus.publish('c', '1');
    expect([a, b]).toEqual([1, 1]);
    await unsubA();
    await bus.publish('c', '2');
    expect([a, b]).toEqual([1, 2]);
  });
});

describe('createPubSub', () => {
  test('defaults to the in-memory adapter', async () => {
    const bus = await createPubSub();
    expect(bus).toBeInstanceOf(InMemoryPubSub);
  });

  test('uses redis when backend=redis and a connection is supplied', async () => {
    const bus = await createPubSub({ backend: 'redis', redis: fakeRedisPair() });
    expect(bus).toBeInstanceOf(RedisPubSub);
  });

  test('degrades to memory when redis is requested without a connection', async () => {
    const bus = await createPubSub({ backend: 'redis' });
    expect(bus).toBeInstanceOf(InMemoryPubSub);
  });
});
