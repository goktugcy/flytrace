import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadRootEnv } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import { type Database, createDb } from '../index.ts';
import { createAirportGroundEventRepo } from './airport-ground-events.ts';

loadRootEnv();

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

let db: Database;
let closeDb: (() => Promise<void>) | undefined;
let airportId: string;
const RUN = crypto.randomUUID().slice(0, 8);

/** Insert a ground transition directly, as the worker projector would. */
async function event(input: {
  flightId: string;
  icao24: string;
  state: string;
  previousState: string | null;
  minutesAgo: number;
  runwayRef?: string;
}): Promise<void> {
  await db.execute(sql`
    insert into airport_ground_events
      (flight_id, icao24, airport_id, state, previous_state, gate_ref, runway_ref, lat, lon, occurred_at, dedupe_key)
    values (${input.flightId}::uuid, ${input.icao24}, ${airportId}::uuid, ${input.state},
            ${input.previousState}, null, ${input.runwayRef ?? null}, 41.0, 28.0,
            now() - (${input.minutesAgo} || ' minutes')::interval,
            ${`${RUN}-${input.flightId}-${input.state}-${input.minutesAgo}`})
    on conflict (dedupe_key) do nothing`);
}

beforeAll(async () => {
  if (!databaseUrl) return;
  const created = createDb({ url: databaseUrl, max: 2 });
  db = created.db;
  closeDb = created.close;
  const rows = (await db.execute(sql`
    insert into airports (iata, icao, name, location)
    values (null, ${`T${RUN.slice(0, 3)}`}, ${`Movements Test ${RUN}`},
            ST_SetSRID(ST_MakePoint(28.0, 41.0), 4326)::geography)
    returning id`)) as unknown as { id: string }[];
  airportId = rows[0]?.id as string;
});

afterAll(async () => {
  if (!databaseUrl) return;
  await db.execute(sql`delete from airport_ground_events where airport_id = ${airportId}::uuid`);
  await db.execute(sql`delete from airports where id = ${airportId}::uuid`);
  await closeDb?.();
});

describeDb('movementsForAirport', () => {
  test('reports a departure only once it is actually airborne', async () => {
    const repo = createAirportGroundEventRepo(db);
    const f = crypto.randomUUID();
    // A takeoff roll can be aborted, so it must not count as a departure.
    await event({
      flightId: f,
      icao24: 'aaa111',
      state: 'TAKEOFF_ROLL',
      previousState: 'LINE_UP',
      minutesAgo: 20,
    });

    expect(await repo.movementsForAirport(airportId, 'departure')).toHaveLength(0);

    await event({
      flightId: f,
      icao24: 'aaa111',
      state: 'AIRBORNE',
      previousState: 'TAKEOFF_ROLL',
      minutesAgo: 19,
      runwayRef: '16L',
    });

    const deps = await repo.movementsForAirport(airportId, 'departure');
    expect(deps).toHaveLength(1);
    expect(deps[0]?.icao24).toBe('aaa111');
    expect(deps[0]?.runwayRef).toBe('16L');
  });

  test('a climb that did not start on this runway is not a departure from here', async () => {
    const repo = createAirportGroundEventRepo(db);
    // An overflight climbing through the area reaches AIRBORNE from CRUISE or
    // UNKNOWN, never from the runway states.
    await event({
      flightId: crypto.randomUUID(),
      icao24: 'bbb222',
      state: 'AIRBORNE',
      previousState: 'UNKNOWN',
      minutesAgo: 10,
    });
    const codes = (await repo.movementsForAirport(airportId, 'departure')).map((m) => m.icao24);
    expect(codes).not.toContain('bbb222');
  });

  test('reports touchdown as the arrival, and only once per aircraft', async () => {
    const repo = createAirportGroundEventRepo(db);
    const f = crypto.randomUUID();
    await event({
      flightId: f,
      icao24: 'ccc333',
      state: 'LANDING',
      previousState: 'APPROACH',
      minutesAgo: 8,
    });
    // TAXI_IN and ARRIVED_GATE follow every landing; counting them would list
    // one arrival three times.
    await event({
      flightId: f,
      icao24: 'ccc333',
      state: 'TAXI_IN',
      previousState: 'LANDING',
      minutesAgo: 7,
    });
    await event({
      flightId: f,
      icao24: 'ccc333',
      state: 'ARRIVED_GATE',
      previousState: 'TAXI_IN',
      minutesAgo: 5,
    });

    const arrivals = await repo.movementsForAirport(airportId, 'arrival');
    expect(arrivals.filter((a) => a.icao24 === 'ccc333')).toHaveLength(1);
  });

  test('a go-around that lands twice still yields one row', async () => {
    const repo = createAirportGroundEventRepo(db);
    const f = crypto.randomUUID();
    await event({
      flightId: f,
      icao24: 'ddd444',
      state: 'LANDING',
      previousState: 'APPROACH',
      minutesAgo: 30,
    });
    await event({
      flightId: f,
      icao24: 'ddd444',
      state: 'LANDING',
      previousState: 'APPROACH',
      minutesAgo: 12,
    });

    const rows = (await repo.movementsForAirport(airportId, 'arrival')).filter(
      (a) => a.icao24 === 'ddd444',
    );
    expect(rows).toHaveLength(1);
    // The surviving row must be the most recent attempt.
    const ageMin = (Date.now() - Date.parse(rows[0]?.occurredAt as string)) / 60_000;
    expect(ageMin).toBeLessThan(20);
  });

  test('orders by time, newest first — not by flight id', async () => {
    const repo = createAirportGroundEventRepo(db);
    for (const [i, hex] of ['eee1', 'eee2', 'eee3'].entries()) {
      const f = crypto.randomUUID();
      await event({
        flightId: f,
        icao24: hex,
        state: 'LANDING',
        previousState: 'APPROACH',
        minutesAgo: 60 - i * 10,
      });
    }
    const rows = await repo.movementsForAirport(airportId, 'arrival');
    const times = rows.map((r) => Date.parse(r.occurredAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  test('honours the time window', async () => {
    const repo = createAirportGroundEventRepo(db);
    await event({
      flightId: crypto.randomUUID(),
      icao24: 'old999',
      state: 'LANDING',
      previousState: 'APPROACH',
      minutesAgo: 60 * 20,
    });
    const recent = await repo.movementsForAirport(airportId, 'arrival', {
      sinceMs: 60 * 60 * 1000,
    });
    expect(recent.map((r) => r.icao24)).not.toContain('old999');

    const wide = await repo.movementsForAirport(airportId, 'arrival', {
      sinceMs: 24 * 60 * 60 * 1000,
      limit: 100,
    });
    expect(wide.map((r) => r.icao24)).toContain('old999');
  });
});
