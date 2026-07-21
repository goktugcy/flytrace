import { describe, expect, test } from 'bun:test';
import { createLogger, fixedClock, makeEnvelope } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { StreamConsumer } from './consumer.ts';
import type { Notifier } from './notifier.ts';

const EVENT_ID = '1700000000000-0';
const clock = fixedClock(1_700_000_000_000);
const envelope = makeEnvelope(
  {
    type: 'TakeoffDetected',
    occurredAt: '2023-11-14T22:13:20.000Z',
    dedupeKey: 'flight-1:takeoff',
    partitionKey: '00000000-0000-7000-8000-000000000001',
    payload: {
      flightId: '00000000-0000-7000-8000-000000000001',
      at: '2023-11-14T22:13:20.000Z',
      lat: 41,
      lon: 29,
      altFt: 1000,
      confidence: 1,
      source: 'fixture',
    },
  },
  { producer: 'tracker', clock },
);

class FakeRedis {
  acked: string[] = [];
  newReads = 0;

  async xautoclaim() {
    return ['0-0', [[EVENT_ID, ['e', JSON.stringify(envelope)]]], []];
  }

  async xreadgroup() {
    this.newReads += 1;
    return null;
  }

  async xack(_key: string, _group: string, ...ids: string[]) {
    this.acked.push(...ids);
    return ids.length;
  }
}

function makeConsumer(redis: FakeRedis, handle: (value: unknown) => Promise<void>) {
  return new StreamConsumer(
    redis as unknown as Redis,
    'test:',
    { handle } as unknown as Notifier,
    createLogger({ level: 'error', base: {} }),
    {
      group: 'notifier',
      consumer: 'notifier-test',
      batchSize: 10,
      blockMs: 1,
      pendingClaimIdleMs: 30_000,
    },
  );
}

describe('StreamConsumer pending recovery', () => {
  test('reclaims, handles and acknowledges an abandoned delivery', async () => {
    const redis = new FakeRedis();
    const handled: unknown[] = [];
    const consumer = makeConsumer(redis, async (value) => {
      handled.push(value);
    });

    expect(await consumer.recoverPending()).toBe(1);
    expect(handled).toHaveLength(1);
    expect(redis.acked).toEqual([EVENT_ID]);
  });

  test('processes reclaimed work before reading new stream entries', async () => {
    const redis = new FakeRedis();
    const consumer = makeConsumer(redis, async () => {});

    expect(await consumer.runOnce()).toBe(1);
    expect(redis.newReads).toBe(0);
  });
});
