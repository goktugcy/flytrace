import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { InMemoryFlightRegistry, InMemoryLock } from './memory.ts';

describe('InMemoryFlightRegistry', () => {
  test('mints a stable id per icao24 until released', async () => {
    const reg = new InMemoryFlightRegistry(fixedClock(1));
    const a = await reg.resolve('abc123');
    const b = await reg.resolve('abc123');
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(false);
    expect(b.flightId).toBe(a.flightId);

    await reg.release('abc123');
    const c = await reg.resolve('abc123');
    expect(c.isNew).toBe(true);
    expect(c.flightId).not.toBe(a.flightId); // new leg
  });
});

describe('InMemoryLock', () => {
  test('grants exclusively and honours the fencing token', async () => {
    const clock = fixedClock(0);
    const lock = new InMemoryLock(clock);

    const t1 = await lock.acquire('leader', 1000);
    expect(t1).not.toBeNull();
    expect(await lock.acquire('leader', 1000)).toBeNull(); // held

    expect(await lock.renew('leader', 'wrong-token', 1000)).toBe(false);
    expect(await lock.renew('leader', t1 as string, 1000)).toBe(true);

    await lock.release('leader', t1 as string);
    expect(await lock.acquire('leader', 1000)).not.toBeNull(); // free again
  });

  test('lets a lock expire after its ttl', async () => {
    const clock = fixedClock(0);
    const lock = new InMemoryLock(clock);
    await lock.acquire('leader', 1000);
    clock.advance(1001);
    expect(await lock.acquire('leader', 1000)).not.toBeNull(); // expired → grantable
  });
});
