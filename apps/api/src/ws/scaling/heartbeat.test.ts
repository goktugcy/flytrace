import { describe, expect, test } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import { HeartbeatManager, type IntervalTimer } from './heartbeat.ts';

/** Manually-fireable timer for deterministic tests. */
function manualTimer(): IntervalTimer & { fire(): void; running: boolean } {
  let fn: (() => void) | null = null;
  return {
    running: false,
    set(cb) {
      fn = cb;
      this.running = true;
      return () => {
        fn = null;
        this.running = false;
      };
    },
    fire() {
      fn?.();
    },
  };
}

describe('HeartbeatManager', () => {
  test('markAlive tracks a connection; tick keeps fresh ones', () => {
    const clock = fixedClock(0);
    const evicted: string[] = [];
    const hb = new HeartbeatManager({
      intervalMs: 1000,
      onTimeout: (id) => evicted.push(id),
      clock,
    });
    hb.markAlive('c1');
    clock.advance(500);
    expect(hb.tick()).toEqual([]);
    expect(evicted).toEqual([]);
    expect(hb.size).toBe(1);
  });

  test('evicts a connection after maxMissed intervals', () => {
    const clock = fixedClock(0);
    const evicted: string[] = [];
    const hb = new HeartbeatManager({
      intervalMs: 1000,
      maxMissed: 2,
      onTimeout: (id) => evicted.push(id),
      clock,
    });
    hb.markAlive('c1');
    clock.advance(2001); // > 2 * 1000
    expect(hb.tick()).toEqual(['c1']);
    expect(evicted).toEqual(['c1']);
    expect(hb.size).toBe(0);
  });

  test('a pong before the deadline resets the miss count', () => {
    const clock = fixedClock(0);
    const hb = new HeartbeatManager({ intervalMs: 1000, maxMissed: 2, onTimeout: () => {}, clock });
    hb.markAlive('c1');
    clock.advance(1500);
    hb.markAlive('c1'); // pong
    clock.advance(1500); // only 1500 since last pong
    expect(hb.tick()).toEqual([]);
    expect(hb.size).toBe(1);
  });

  test('remove stops tracking without eviction', () => {
    const clock = fixedClock(0);
    const evicted: string[] = [];
    const hb = new HeartbeatManager({
      intervalMs: 1000,
      onTimeout: (id) => evicted.push(id),
      clock,
    });
    hb.markAlive('c1');
    hb.remove('c1');
    clock.advance(10_000);
    expect(hb.tick()).toEqual([]);
    expect(evicted).toEqual([]);
  });

  test('start/close drive and dispose the injected timer', () => {
    const clock = fixedClock(0);
    const timer = manualTimer();
    const evicted: string[] = [];
    const hb = new HeartbeatManager({
      intervalMs: 1000,
      maxMissed: 1,
      onTimeout: (id) => evicted.push(id),
      clock,
      timer,
    });
    hb.markAlive('c1');
    hb.start();
    expect(timer.running).toBe(true);
    clock.advance(1001);
    timer.fire();
    expect(evicted).toEqual(['c1']);
    hb.close();
    expect(timer.running).toBe(false);
  });

  test('start is idempotent', () => {
    const timer = manualTimer();
    let sets = 0;
    const wrapped: IntervalTimer = {
      set(fn, ms) {
        sets += 1;
        return timer.set(fn, ms);
      },
    };
    const hb = new HeartbeatManager({ intervalMs: 1000, onTimeout: () => {}, timer: wrapped });
    hb.start();
    hb.start();
    expect(sets).toBe(1);
  });
});
