import { describe, expect, test } from 'bun:test';
import type { EventInput, FlightRepo, FlightUpsert, PositionInput } from '@flytrace/db';
import {
  type DomainEventInput,
  type EventEnvelope,
  createLogger,
  fixedClock,
  makeEnvelope,
} from '@flytrace/shared';
import { Persister, dbEventType } from './persist.ts';

class FakeRepo implements FlightRepo {
  flights: FlightUpsert[] = [];
  positions: PositionInput[] = [];
  events: EventInput[] = [];
  ended: { flightId: string; reason: string }[] = [];

  async upsertFlight(f: FlightUpsert): Promise<void> {
    this.flights.push(f);
  }
  async insertPositions(rows: PositionInput[]): Promise<number> {
    this.positions.push(...rows);
    return rows.length;
  }
  async insertEvent(e: EventInput): Promise<void> {
    this.events.push(e);
  }
  async enrichFlight(): Promise<void> {}
  async endFlight(
    flightId: string,
    _at: Date,
    reason: 'landed' | 'arrived' | 'timeout' | 'diverted',
  ): Promise<void> {
    this.ended.push({ flightId, reason });
  }
}

const clock = fixedClock(1_700_000_000_000);
const F = '00000000-0000-7000-8000-000000000001';

function env<T>(input: DomainEventInput<T>): EventEnvelope<T> {
  return makeEnvelope(input, { producer: 'tracker', clock, correlationId: F });
}

const detected = env({
  type: 'FlightDetected',
  occurredAt: '2023-11-14T22:13:20.000Z',
  dedupeKey: `${F}:detected`,
  partitionKey: F,
  payload: {
    flightId: F,
    icao24: '4bb1a2',
    callsign: null,
    firstPosition: { lat: 41, lon: 29, ts: '2023-11-14T22:13:20.000Z' },
    source: 'fixture',
  },
});
const position = (ts: string, lat: number) =>
  env({
    type: 'PositionUpdated',
    occurredAt: ts,
    dedupeKey: `${F}:pos:${ts}`,
    partitionKey: F,
    payload: {
      flightId: F,
      icao24: '4bb1a2',
      lat,
      lon: 29,
      altFt: 1000.6,
      geoAltitudeFt: 1100.4,
      headingDeg: 90,
      gsKt: 100,
      vrateFpm: 640.2,
      onGround: false,
      squawk: '7000',
      source: 'adsb',
      ts,
    },
  });
const takeoff = env({
  type: 'TakeoffDetected',
  occurredAt: '2023-11-14T22:15:00.000Z',
  dedupeKey: `${F}:takeoff`,
  partitionKey: F,
  payload: {
    flightId: F,
    icao24: '4bb1a2',
    at: '2023-11-14T22:15:00.000Z',
    lat: 41.3,
    lon: 29,
    altFt: 950,
    confidence: 0.9,
    source: 'fixture',
  },
});
const climb = env({
  type: 'ClimbDetected',
  occurredAt: '2023-11-14T22:16:00.000Z',
  dedupeKey: `${F}:vphase:top_of_climb:2`,
  partitionKey: F,
  payload: {
    flightId: F,
    phase: 'top_of_climb',
    at: '2023-11-14T22:16:00.000Z',
    altFt: 30000,
    vrateFpm: 0,
    confidence: 0.8,
    source: 'tracker',
  },
});
const ended = env({
  type: 'FlightEnded',
  occurredAt: '2023-11-14T22:30:00.000Z',
  dedupeKey: `${F}:ended`,
  partitionKey: F,
  payload: { flightId: F, icao24: '4bb1a2', endedAt: '2023-11-14T22:30:00.000Z', reason: 'landed' },
});

describe('dbEventType mapping', () => {
  test('maps domain events to db enum values', () => {
    expect(dbEventType(detected)).toBe('flight_detected');
    expect(dbEventType(takeoff)).toBe('takeoff');
    expect(dbEventType(climb)).toBe('top_of_climb');
    expect(dbEventType(ended)).toBe('flight_ended');
    expect(dbEventType(position('2023-11-14T22:13:20.000Z', 41))).toBeNull(); // positions not events
  });
});

describe('Persister', () => {
  const logger = createLogger({ level: 'error', base: {} });

  test('creates the flight then persists positions + derived events', async () => {
    const repo = new FakeRepo();
    const p = new Persister(repo, logger);

    await p.handle(detected);
    await p.handle(position('2023-11-14T22:13:50.000Z', 41.1));
    await p.handle(position('2023-11-14T22:14:20.000Z', 41.2));
    await p.handle(takeoff);
    await p.handle(climb);
    await p.flush();

    expect(repo.flights).toHaveLength(1);
    expect(repo.flights[0]).toMatchObject({
      flightId: F,
      callsign: '4bb1a2',
      flightDate: '2023-11-14',
    });

    expect(repo.positions).toHaveLength(2);
    expect(repo.positions[0]).toMatchObject({
      altitudeFt: 1001,
      geoAltitudeFt: 1100,
      verticalRateFpm: 640,
      onGround: false,
      squawk: '7000',
      source: 'adsb',
    });

    const types = repo.events.map((e) => e.type);
    expect(types).toEqual(['flight_detected', 'takeoff', 'top_of_climb']);
    expect(repo.events.find((e) => e.type === 'takeoff')?.confidence).toBe(0.9);
  });

  test('FlightEnded flushes pending positions then finalizes the leg', async () => {
    const repo = new FakeRepo();
    const p = new Persister(repo, logger);

    await p.handle(detected);
    await p.handle(position('2023-11-14T22:29:00.000Z', 41.9));
    expect(repo.positions).toHaveLength(0); // still buffered
    await p.handle(ended);

    expect(repo.positions).toHaveLength(1); // flushed before finalize
    expect(repo.ended).toEqual([{ flightId: F, reason: 'landed' }]);
    expect(repo.events.map((e) => e.type)).toContain('flight_ended');
  });

  test('auto-flushes when the position buffer fills', async () => {
    const repo = new FakeRepo();
    const p = new Persister(repo, logger, { maxPositionBatch: 3 });
    await p.handle(detected);
    for (let i = 0; i < 3; i += 1) await p.handle(position(`2023-11-14T22:2${i}:00.000Z`, 41 + i));
    expect(repo.positions).toHaveLength(3); // flushed at threshold, no explicit flush()
  });
});
