import { describe, expect, test } from 'bun:test';
import { InMemoryDigestQueue } from './queue.ts';

const noSleep = (): Promise<void> => Promise.resolve();

describe('InMemoryDigestQueue', () => {
  test('processes queued jobs successfully', async () => {
    const seen: string[] = [];
    const q = new InMemoryDigestQueue({
      handler: async (job) => {
        seen.push(job.userId);
      },
      sleep: noSleep,
    });
    await q.enqueue('a');
    await q.enqueue('b');
    expect(q.size()).toBe(2);

    await q.drain();

    expect(seen).toEqual(['a', 'b']);
    expect(q.processed.map((j) => j.userId)).toEqual(['a', 'b']);
    expect(q.size()).toBe(0);
    expect(q.deadLettered).toHaveLength(0);
  });

  test('retries a flaky job with backoff, then records success', async () => {
    let attempts = 0;
    const backoffs: number[] = [];
    const q = new InMemoryDigestQueue({
      handler: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('flaky');
      },
      maxAttempts: 3,
      backoffMs: (n) => n * 10,
      sleep: async (ms) => {
        backoffs.push(ms);
      },
    });
    await q.enqueue('a');
    await q.drain();

    expect(attempts).toBe(3);
    expect(q.processed[0]!.attempts).toBe(3);
    // Backoff applied before attempts 2 and 3 only.
    expect(backoffs).toEqual([20, 30]);
    expect(q.deadLettered).toHaveLength(0);
  });

  test('dead-letters a job that exhausts all attempts', async () => {
    const q = new InMemoryDigestQueue({
      handler: async () => {
        throw new Error('permanent');
      },
      maxAttempts: 2,
      sleep: noSleep,
    });
    await q.enqueue('a');
    await q.drain();

    expect(q.processed).toHaveLength(0);
    expect(q.deadLettered).toHaveLength(1);
    expect(q.deadLettered[0]!.job.userId).toBe('a');
    expect(q.deadLettered[0]!.job.attempts).toBe(2);
    expect(q.deadLettered[0]!.error).toBe('permanent');
  });
});
