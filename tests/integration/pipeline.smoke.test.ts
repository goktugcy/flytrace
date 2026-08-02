/**
 * End-to-end backbone smoke test.
 *
 *   tracker fixture → Redis stream → worker consumer → Postgres → API response
 *
 * This is deliberately NOT an exhaustive functional test. Its job is to prove
 * that the pieces are still WIRED TOGETHER: that the tracker's event envelope is
 * the shape the worker's consumer group reads, that the persister's writes land
 * in the tables the API's read repository queries, and that the API serves them
 * back. Those are exactly the seams that unit tests with fakes cannot protect,
 * and exactly the ones that break silently during a refactor.
 *
 * Requires a live Postgres (migrated) and Redis. It SKIPS itself when either is
 * absent, so `bun test` stays runnable with no infrastructure.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createDb, createFlightReadRepo, createFlightRepo, sql } from '@flytrace/db';
import type { Database } from '@flytrace/db';
import {
  type EventEnvelope,
  createLogger,
  redisKeyPrefix,
  systemClock,
  uuidv7,
} from '@flytrace/shared';
import { Redis } from 'ioredis';
import { createApp } from '../../apps/api/src/app.ts';
import type { AppContext } from '../../apps/api/src/context.ts';
import { testApiConfig } from '../../apps/api/src/testing/context.ts';
import { RedisEventBus } from '../../apps/tracker/src/bus/redis-bus.ts';
import { StreamConsumer } from '../../apps/worker/src/consumer.ts';
import { Persister } from '../../apps/worker/src/persist.ts';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIntegration = databaseUrl && redisUrl ? describe : describe.skip;

/** Unique per run, so repeated runs cannot collide in Redis or Postgres. */
const RUN_ID = crypto.randomUUID().slice(0, 8);
const PREFIX = `${redisKeyPrefix('local')}smoke:${RUN_ID}:`;
const logger = createLogger({ level: 'error' });

let db: Database;
let closeDb: (() => Promise<void>) | undefined;
let redis: Redis;

/** The tracker's own fixture — the same bytes the fixture source replays. */
interface FixtureSample {
  icao24?: string;
  callsign?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | string;
  track?: number;
  gs?: number;
  baro_rate?: number;
}

function loadFixtureSample(): FixtureSample {
  const raw = readFileSync(
    new URL('../../apps/tracker/fixtures/ist-departure.json', import.meta.url),
    'utf8',
  );
  const parsed = JSON.parse(raw) as
    | { ac?: FixtureSample[]; aircraft?: FixtureSample[]; states?: unknown[] }
    | FixtureSample[];
  const list = Array.isArray(parsed) ? parsed : (parsed.ac ?? parsed.aircraft ?? []);
  const sample = list[0];
  if (!sample) throw new Error('tracker fixture contains no aircraft sample');
  return sample;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

beforeAll(async () => {
  if (!databaseUrl || !redisUrl) return;
  const created = createDb({ url: databaseUrl, max: 2 });
  db = created.db;
  closeDb = created.close;
  redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
});

afterAll(async () => {
  if (!databaseUrl || !redisUrl) return;
  // Leave no Redis keys behind: this test creates a stream + consumer group.
  const keys = await redis.keys(`${PREFIX}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
  await closeDb?.();
});

describeIntegration('pipeline smoke: tracker → redis → worker → postgres → api', () => {
  test('a fixture position travels the whole backbone and comes back out of the API', async () => {
    const sample = loadFixtureSample();
    const flightId = uuidv7();
    const icao24 = (sample.icao24 ?? '4bb1a2').trim().toLowerCase();
    const callsign = (sample.callsign ?? 'THY1SMOKE').trim();
    const occurredAt = new Date().toISOString();

    const bus = new RedisEventBus(redis, PREFIX);
    const flightRepo = createFlightRepo(db);
    const readRepo = createFlightReadRepo(db);

    try {
      // ── 1. tracker publishes what its detectors produce ──
      const detected: EventEnvelope = {
        id: uuidv7(),
        type: 'FlightDetected',
        version: 1,
        occurredAt,
        emittedAt: occurredAt,
        producer: 'tracker',
        correlationId: `smoke-${RUN_ID}`,
        dedupeKey: `smoke-detected-${flightId}`,
        partitionKey: flightId,
        payload: {
          flightId,
          icao24,
          callsign,
          firstPosition: { ts: occurredAt },
          source: 'fixture',
        },
      };

      const position: EventEnvelope = {
        id: uuidv7(),
        type: 'PositionUpdated',
        version: 1,
        occurredAt,
        emittedAt: occurredAt,
        producer: 'tracker',
        correlationId: `smoke-${RUN_ID}`,
        dedupeKey: `smoke-position-${flightId}`,
        partitionKey: flightId,
        payload: {
          flightId,
          icao24,
          lat: numberOrNull(sample.lat) ?? 41.2753,
          lon: numberOrNull(sample.lon) ?? 28.7519,
          altFt: numberOrNull(sample.alt_baro) ?? 12_000,
          headingDeg: numberOrNull(sample.track) ?? 90,
          gsKt: numberOrNull(sample.gs) ?? 320,
          vrateFpm: numberOrNull(sample.baro_rate) ?? 1800,
          onGround: false,
          ts: occurredAt,
          callsign,
          source: 'fixture',
        },
      };

      await bus.publish(detected);
      await bus.publish(position);

      // The durable stream is what the worker actually reads — assert it exists
      // before blaming the consumer for finding nothing.
      const streamLength = await redis.xlen(`${PREFIX}stream:events`);
      expect(streamLength).toBeGreaterThanOrEqual(2);

      // ── 2. worker consumes the group and projects into Postgres ──
      const persister = new Persister(flightRepo, logger, { maxPositionBatch: 1 });
      const consumer = new StreamConsumer(redis, PREFIX, persister, logger, {
        group: `smoke-${RUN_ID}`,
        consumer: 'smoke-1',
        batchSize: 10,
        blockMs: 100,
      });
      await consumer.ensureGroup();

      let processed = 0;
      for (let attempt = 0; attempt < 5 && processed < 2; attempt += 1) {
        processed += await consumer.runOnce();
      }
      await persister.flush();
      expect(processed).toBeGreaterThanOrEqual(2);

      // ── 3. the rows are in the tables the API reads ──
      const flightRow = await readRepo.getFlightById(flightId);
      expect(flightRow?.callsign).toBe(callsign);

      const latest = await readRepo.getLatestPosition(flightId);
      expect(latest?.icao24).toBe(icao24);
      expect(latest?.lat).toBeCloseTo(numberOrNull(sample.lat) ?? 41.2753, 3);

      // ── 4. the API serves it back over HTTP ──
      const ctx = {
        config: testApiConfig({ APP_ENV: 'local' }),
        logger,
        clock: systemClock,
        db,
        redis,
        redisPrefix: PREFIX,
        metrics: undefined,
        close: async () => {},
      } as unknown as AppContext;

      const app = createApp(ctx);
      const res = await app.request(`/api/v1/flights/id/${flightId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { flight?: { callsign?: string }; callsign?: string };
      };
      const served = body.data.flight?.callsign ?? body.data.callsign;
      expect(served).toBe(callsign);
    } finally {
      // Cascades to positions and events.
      await db.execute(sql`delete from flights where id = ${flightId}::uuid`);
      await bus.close();
    }
  }, 60_000);

  test('the API answers readiness against the real Postgres and Redis', async () => {
    const ctx = {
      config: testApiConfig({ APP_ENV: 'local' }),
      logger,
      clock: systemClock,
      db,
      redis,
      redisPrefix: PREFIX,
      metrics: undefined,
      close: async () => {},
    } as unknown as AppContext;

    const res = await createApp(ctx).request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, checks: { db: 'ok', redis: 'ok' } });
  });
});
