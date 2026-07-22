import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadRootEnv } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import { type Database, createDb, createFlightReadRepo, createFlightRepo } from '../index.ts';

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Database;
let closeDb: (() => Promise<void>) | undefined;

beforeAll(() => {
  if (!databaseUrl) return;
  const created = createDb({ url: databaseUrl, max: 1 });
  db = created.db;
  closeDb = created.close;
});

afterAll(async () => {
  await closeDb?.();
});

describeDb('flight read repository (postgres integration)', () => {
  test('getRecentFlightByIcao24 accepts a Date cutoff', async () => {
    const read = createFlightReadRepo(db);
    const write = createFlightRepo(db);
    const flightId = crypto.randomUUID();
    const ts = new Date('2026-07-19T20:00:00.000Z');

    try {
      await write.upsertFlight({
        flightId,
        callsign: `TST${flightId.slice(0, 6).toUpperCase()}`,
        flightDate: '2026-07-19',
        source: 'test',
        lastSeenAt: ts,
      });
      await write.insertPositions([
        {
          flightId,
          ts,
          icao24: 'abc123',
          lon: 29,
          lat: 41,
          altitudeFt: 30000,
          geoAltitudeFt: 30500,
          headingDeg: 90,
          groundSpeedKt: 420,
          verticalRateFpm: 0,
          onGround: false,
          squawk: '7000',
          source: 'test',
        },
      ]);

      const found = await read.getRecentFlightByIcao24(
        'ABC123',
        new Date('2026-07-19T19:59:00.000Z'),
      );
      expect(found?.id).toBe(flightId);

      const tooNew = await read.getRecentFlightByIcao24(
        'abc123',
        new Date('2026-07-19T20:01:00.000Z'),
      );
      expect(tooNew).toBeNull();

      const sameLeg = await read.getRecentFlightByIdentity(
        'ABC123',
        `TST${flightId.slice(0, 6).toUpperCase()}`,
        new Date('2026-07-19T19:55:00.000Z'),
        new Date('2026-07-19T20:05:00.000Z'),
      );
      expect(sameLeg?.id).toBe(flightId);

      const wrongCallsign = await read.getRecentFlightByIdentity(
        'abc123',
        'TSTOTHER',
        new Date('2026-07-19T19:55:00.000Z'),
        new Date('2026-07-19T20:05:00.000Z'),
      );
      expect(wrongCallsign).toBeNull();
    } finally {
      await db.execute(sql`delete from flights where id = ${flightId}`);
    }
  });
});
