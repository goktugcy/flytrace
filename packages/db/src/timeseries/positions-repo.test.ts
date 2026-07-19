import { describe, expect, test } from 'bun:test';
import {
  type ExecutableDb,
  PgPositionRepo,
  TimescalePositionRepo,
  type TimeseriesPositionInput,
  createPositionTimeseriesRepo,
} from './positions-repo.ts';

/** Fake db that records every query and returns a canned result queue. */
function fakeDb(results: unknown[] = []): ExecutableDb & { calls: unknown[] } {
  const calls: unknown[] = [];
  const queue = [...results];
  return {
    calls,
    async execute(query: unknown) {
      calls.push(query);
      return queue.length > 0 ? queue.shift() : [];
    },
  };
}

const sampleRow = {
  ts: '2026-01-01T00:00:00.000Z',
  lat: 41.1,
  lon: 29.0,
  altitudeFt: 35000,
  headingDeg: 90,
  groundSpeedKt: 450,
  verticalRateFpm: 0,
  onGround: false,
};

describe('PgPositionRepo', () => {
  test('lastPosition returns the first row or null', async () => {
    const withRow = new PgPositionRepo(fakeDb([[sampleRow]]));
    expect(await withRow.lastPosition('f1')).toEqual(sampleRow);

    const empty = new PgPositionRepo(fakeDb([[]]));
    expect(await empty.lastPosition('f1')).toBeNull();
  });

  test('trail returns the row array and issues one query', async () => {
    const db = fakeDb([[sampleRow, sampleRow]]);
    const repo = new PgPositionRepo(db);
    const rows = await repo.trail('f1', 10);
    expect(rows).toHaveLength(2);
    expect(db.calls).toHaveLength(1);
  });

  test('altitude/speed histories delegate to a single query each', async () => {
    const db = fakeDb([
      [{ ts: sampleRow.ts, altitudeFt: 35000 }],
      [{ ts: sampleRow.ts, groundSpeedKt: 450 }],
    ]);
    const repo = new PgPositionRepo(db);
    expect(await repo.altitudeHistory('f1')).toEqual([{ ts: sampleRow.ts, altitudeFt: 35000 }]);
    expect(await repo.speedHistory('f1')).toEqual([{ ts: sampleRow.ts, groundSpeedKt: 450 }]);
    expect(db.calls).toHaveLength(2);
  });

  test('insertBatch short-circuits on empty input (no query)', async () => {
    const db = fakeDb();
    const repo = new PgPositionRepo(db);
    expect(await repo.insertBatch([])).toBe(0);
    expect(db.calls).toHaveLength(0);
  });

  test('insertBatch issues one query and returns the row count', async () => {
    const db = fakeDb();
    const repo = new PgPositionRepo(db);
    const rows: TimeseriesPositionInput[] = [
      {
        flightId: 'f1',
        ts: new Date('2026-01-01T00:00:00Z'),
        icao24: 'abc123',
        lon: 29,
        lat: 41,
        altitudeFt: 30000,
        headingDeg: 90,
        groundSpeedKt: 400,
        verticalRateFpm: 0,
        onGround: false,
        source: 'opensky',
      },
    ];
    expect(await repo.insertBatch(rows)).toBe(1);
    expect(db.calls).toHaveLength(1);
  });
});

describe('TimescalePositionRepo', () => {
  test('delegates track reads/writes to the Pg backend', async () => {
    const db = fakeDb([[sampleRow]]);
    const repo = new TimescalePositionRepo(db);
    expect(await repo.lastPosition('f1')).toEqual(sampleRow);
    expect(await repo.insertBatch([])).toBe(0);
  });

  test('aggregates histories with a single bucketed query each', async () => {
    const db = fakeDb([
      [{ ts: sampleRow.ts, altitudeFt: 35000 }],
      [{ ts: sampleRow.ts, groundSpeedKt: 450 }],
    ]);
    const repo = new TimescalePositionRepo(db, '5 minutes');
    expect(await repo.altitudeHistory('f1')).toHaveLength(1);
    expect(await repo.speedHistory('f1')).toHaveLength(1);
    expect(db.calls).toHaveLength(2);
  });
});

describe('createPositionTimeseriesRepo', () => {
  const db = fakeDb() as unknown as Parameters<typeof createPositionTimeseriesRepo>[0];

  test('defaults to the postgres backend', async () => {
    const repo = await createPositionTimeseriesRepo(db);
    expect(repo).toBeInstanceOf(PgPositionRepo);
  });

  test('selects the timescale backend when configured', async () => {
    const repo = await createPositionTimeseriesRepo(db, { backend: 'timescale' });
    expect(repo).toBeInstanceOf(TimescalePositionRepo);
  });

  test('falls back to postgres on an unknown backend', async () => {
    const warnings: string[] = [];
    const repo = await createPositionTimeseriesRepo(db, {
      backend: 'cassandra',
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(repo).toBeInstanceOf(PgPositionRepo);
    expect(warnings.length).toBe(1);
  });
});
