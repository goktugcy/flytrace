import { describe, expect, test } from 'bun:test';
import { IntervalDigestScheduler, type SchedulerTimer, createRetry } from './scheduler.ts';

/** A timer whose interval callback can be fired manually in tests. */
function fakeTimer(): SchedulerTimer & { fire: () => void; started: boolean } {
  let cb: (() => void) | null = null;
  return {
    started: false,
    setInterval(fn: () => void) {
      cb = fn;
      this.started = true;
      return 1;
    },
    clearInterval() {
      cb = null;
      this.started = false;
    },
    fire() {
      cb?.();
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('createRetry', () => {
  test('retries until success and stops', async () => {
    let calls = 0;
    const retry = createRetry({ attempts: 3, sleep: noSleep });
    const result = await retry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  test('rethrows after exhausting attempts', async () => {
    let calls = 0;
    const retry = createRetry({ attempts: 2, sleep: noSleep });
    await expect(
      retry(async () => {
        calls += 1;
        throw new Error('always');
      }),
    ).rejects.toThrow('always');
    expect(calls).toBe(2);
  });
});

describe('IntervalDigestScheduler', () => {
  test('tick sends a digest for every due user', async () => {
    const sent: string[] = [];
    const scheduler = new IntervalDigestScheduler({
      intervalMs: 1000,
      listDueUsers: () => ['a', 'b', 'c'],
      sendDigest: async (userId) => {
        sent.push(userId);
      },
      retry: createRetry({ attempts: 1, sleep: noSleep }),
    });

    const results = await scheduler.tick();

    expect(sent).toEqual(['a', 'b', 'c']);
    expect(results).toEqual([
      { userId: 'a', ok: true },
      { userId: 'b', ok: true },
      { userId: 'c', ok: true },
    ]);
  });

  test('a failing user is isolated; others still send', async () => {
    const scheduler = new IntervalDigestScheduler({
      intervalMs: 1000,
      listDueUsers: () => ['ok1', 'bad', 'ok2'],
      sendDigest: async (userId) => {
        if (userId === 'bad') throw new Error('nope');
      },
      retry: createRetry({ attempts: 2, sleep: noSleep }),
    });

    const results = await scheduler.tick();

    expect(results).toEqual([
      { userId: 'ok1', ok: true },
      { userId: 'bad', ok: false },
      { userId: 'ok2', ok: true },
    ]);
  });

  test('start wires the interval; the fired callback runs a tick', async () => {
    const timer = fakeTimer();
    const sent: string[] = [];
    const scheduler = new IntervalDigestScheduler({
      intervalMs: 500,
      listDueUsers: () => ['z'],
      sendDigest: async (u) => {
        sent.push(u);
      },
      retry: createRetry({ attempts: 1, sleep: noSleep }),
      timer,
    });

    scheduler.start();
    expect(timer.started).toBe(true);
    timer.fire();
    // Let the fire-and-forget tick resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(['z']);

    scheduler.stop();
    expect(timer.started).toBe(false);
  });

  test('re-entrant tick is skipped while one is in flight', async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = () => r();
    });
    let calls = 0;
    const scheduler = new IntervalDigestScheduler({
      intervalMs: 1000,
      listDueUsers: () => ['a'],
      sendDigest: async () => {
        calls += 1;
        await gate;
      },
      retry: createRetry({ attempts: 1, sleep: noSleep }),
    });

    const first = scheduler.tick();
    const second = await scheduler.tick(); // runs while first is blocked
    expect(second).toEqual([]);
    release();
    await first;
    expect(calls).toBe(1);
  });
});
