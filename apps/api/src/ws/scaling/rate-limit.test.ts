import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { InMemoryConnectionRateLimiter, TokenBucket, createRateLimiter } from './rate-limit.ts';

describe('TokenBucket', () => {
  test('allows up to capacity then blocks', () => {
    const clock = fixedClock(0);
    const b = new TokenBucket(3, 1, clock);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false);
  });

  test('refills over time up to capacity', () => {
    const clock = fixedClock(0);
    const b = new TokenBucket(2, 2, clock); // 2 tokens/sec
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false);
    clock.advance(1000); // +2 tokens, capped at 2
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(true);
    expect(b.tryRemove()).toBe(false);
  });
});

describe('InMemoryConnectionRateLimiter', () => {
  test('per-ip connect rate is independent per ip', () => {
    const clock = fixedClock(0);
    const rl = new InMemoryConnectionRateLimiter({
      connectCapacity: 2,
      connectRefillPerSec: 0,
      messageCapacity: 10,
      clock,
    });
    expect(rl.allowConnect('1.1.1.1')).toBe(true);
    expect(rl.allowConnect('1.1.1.1')).toBe(true);
    expect(rl.allowConnect('1.1.1.1')).toBe(false);
    expect(rl.allowConnect('2.2.2.2')).toBe(true); // separate bucket
  });

  test('per-connection message rate is independent per conn', () => {
    const clock = fixedClock(0);
    const rl = new InMemoryConnectionRateLimiter({
      connectCapacity: 100,
      messageCapacity: 2,
      messageRefillPerSec: 0,
      clock,
    });
    expect(rl.allowMessage('a')).toBe(true);
    expect(rl.allowMessage('a')).toBe(true);
    expect(rl.allowMessage('a')).toBe(false);
    expect(rl.allowMessage('b')).toBe(true);
  });

  test('release drops the per-connection bucket', () => {
    const clock = fixedClock(0);
    const rl = new InMemoryConnectionRateLimiter({
      connectCapacity: 100,
      messageCapacity: 1,
      messageRefillPerSec: 0,
      clock,
    });
    expect(rl.allowMessage('a')).toBe(true);
    expect(rl.allowMessage('a')).toBe(false);
    rl.release('a'); // fresh bucket next time
    expect(rl.allowMessage('a')).toBe(true);
  });
});

describe('createRateLimiter', () => {
  test('defaults to the in-memory limiter', async () => {
    const rl = await createRateLimiter({ maxConnsPerIp: 5, maxMsgsPerSec: 20 });
    expect(rl).toBeInstanceOf(InMemoryConnectionRateLimiter);
  });

  test('unknown backend degrades to memory', async () => {
    const rl = await createRateLimiter({ maxConnsPerIp: 5, maxMsgsPerSec: 20, backend: 'redis' });
    expect(rl).toBeInstanceOf(InMemoryConnectionRateLimiter);
  });

  test('wires config into the buckets', async () => {
    const clock = fixedClock(0);
    const rl = await createRateLimiter({ maxConnsPerIp: 1, maxMsgsPerSec: 1, clock });
    expect(rl.allowConnect('ip')).toBe(true);
    expect(rl.allowConnect('ip')).toBe(false);
  });
});
