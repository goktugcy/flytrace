import { describe, expect, test } from 'bun:test';
import {
  type EventType,
  type FlightEndedPayload,
  InMemoryEventBus,
  baseEnvelopeSchema,
  createLogger,
  fixedClock,
} from '@flytrace/shared';
import frames from '../../fixtures/ist-departure.json' with { type: 'json' };
import {
  DEFAULT_DETECTOR_CONFIG,
  DEFAULT_FLIGHT_LIFECYCLE_CONFIG,
} from '../domain/flight-state.ts';
import type { Position } from '../domain/position.ts';
import { type TrackerMetrics, createTrackerMetrics } from '../metrics.ts';
import { FixturePositionSource } from '../source/fixture-source.ts';
import type { PositionSource } from '../source/port.ts';
import { InMemoryFlightRegistry, InMemoryFlightStateStore, InMemoryLock } from '../state/memory.ts';
import { Tracker, type TrackerOptions } from './tracker.ts';

const LAST_TS_MS = Date.parse('2023-11-14T22:22:50.000Z'); // frame 20
const TIMEOUT_MS = 900_000;

function harness(sourceFrames: unknown[] = frames as unknown[]) {
  const clock = fixedClock(LAST_TS_MS);
  const bus = new InMemoryEventBus();
  const store = new InMemoryFlightStateStore();
  const registry = new InMemoryFlightRegistry(clock);
  const options: TrackerOptions = {
    detector: DEFAULT_DETECTOR_CONFIG,
    sourceLabel: 'fixture',
    sourceTimeMode: 'event',
    lifecycle: {
      ...DEFAULT_FLIGHT_LIFECYCLE_CONFIG,
      removeAfterMs: TIMEOUT_MS,
    },
    pollIntervalMs: 0,
    lockName: 'tracker:leader',
    lockTtlMs: 15_000,
  };
  const tracker = new Tracker({
    source: new FixturePositionSource(sourceFrames),
    store,
    registry,
    lock: new InMemoryLock(clock),
    bus,
    clock,
    logger: createLogger({ level: 'error', base: {} }),
    options,
  });
  return { clock, bus, store, registry, tracker };
}

/** A later sample from a *different* aircraft — advances the tracker's logical
 * (event-time) clock past the idle window so the original flight goes stale. */
function futureFrame(secondsAfterLeg: number): unknown {
  const ts = 1_700_000_570 + secondsAfterLeg; // leg ends at frame-20 ts
  return {
    time: ts,
    states: [['ffffff', 'OTHER1  ', 'Germany', ts, ts, 8.5, 50.0, 3000, false, 200, 90, 0]],
  };
}

function counts(bus: InMemoryEventBus): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of bus.published) out[e.type] = (out[e.type] ?? 0) + 1;
  return out;
}

class QueueSource implements PositionSource {
  readonly name = 'test-live';
  readonly timeMode = 'wall';

  constructor(private readonly frames: Position[][]) {}

  async poll(): Promise<Position[]> {
    return this.frames.shift() ?? [];
  }
}

function livePos(tsMs: number, over: Partial<Position> = {}): Position {
  return {
    icao24: '4bb1a2',
    callsign: 'THY1TG',
    lat: 41,
    lon: 29,
    altFt: 30000,
    headingDeg: 90,
    gsKt: 420,
    vrateFpm: 0,
    onGround: false,
    category: 'jet',
    ts: new Date(tsMs).toISOString(),
    ...over,
  };
}

function liveHarness(
  source: PositionSource,
  startMs = Date.parse('2026-01-01T00:00:00.000Z'),
  metrics?: TrackerMetrics,
) {
  const clock = fixedClock(startMs);
  const bus = new InMemoryEventBus();
  const store = new InMemoryFlightStateStore();
  const registry = new InMemoryFlightRegistry(clock);
  const options: TrackerOptions = {
    detector: DEFAULT_DETECTOR_CONFIG,
    sourceLabel: source.name,
    sourceTimeMode: source.timeMode ?? 'wall',
    lifecycle: DEFAULT_FLIGHT_LIFECYCLE_CONFIG,
    pollIntervalMs: 0,
    lockName: 'tracker:leader',
    lockTtlMs: 15_000,
  };
  const tracker = new Tracker({
    source,
    store,
    registry,
    lock: new InMemoryLock(clock),
    bus,
    clock,
    logger: createLogger({ level: 'error', base: {} }),
    options,
    ...(metrics ? { metrics } : {}),
  });
  return { clock, bus, store, registry, tracker };
}

describe('Tracker — end-to-end over the fixture feed', () => {
  test('drains the whole leg into the expected event mix', async () => {
    const { tracker, bus } = harness();
    await tracker.drain();

    const c = counts(bus);
    expect(c.PositionUpdated).toBe(20);
    expect(c.FlightDetected).toBe(1);
    expect(c.TakeoffDetected).toBe(1);
    expect(c.LandingDetected).toBe(1);
    expect(c.ClimbDetected).toBe(2); // climb + top_of_climb
    expect(c.DescentDetected).toBe(1); // top_of_descent
  });

  test('every published event is a valid, tracker-produced envelope', async () => {
    const { tracker, bus } = harness();
    await tracker.drain();

    for (const e of bus.published) {
      expect(baseEnvelopeSchema.safeParse(e).success).toBe(true);
      expect(e.producer).toBe('tracker');
      expect(e.partitionKey).toBe(e.correlationId); // per-leg trace id
    }
  });

  test('FlightDetected is the first event for the leg', async () => {
    const { tracker, bus } = harness();
    await tracker.drain();
    expect(bus.published[0]?.type).toBe('FlightDetected' satisfies EventType);
  });

  test('does not force-end a flight while its samples are fresh', async () => {
    const { tracker, bus, store } = harness();
    await tracker.drain();
    expect(await store.all()).toHaveLength(1); // still tracked
    expect(bus.published.filter((e) => e.type === 'FlightEnded')).toHaveLength(0);
  });

  test('idle sweep force-ends a flight once event-time moves past the window', async () => {
    // Append a far-later sample from another aircraft; processing it advances the
    // tracker's logical clock so the original (landed) leg is swept as ended.
    const { tracker, bus, store } = harness([
      ...(frames as unknown[]),
      futureFrame(TIMEOUT_MS / 1000 + 1),
    ]);
    await tracker.drain();

    const ended = bus.published.filter((e) => e.type === 'FlightEnded');
    expect(ended).toHaveLength(1);
    expect((ended[0]?.payload as FlightEndedPayload).reason).toBe('landed');
    const remaining = await store.all();
    expect(remaining).toHaveLength(1); // only the other aircraft remains
    expect(remaining[0]?.icao24).toBe('ffffff');
  });
});

describe('Tracker — live-source freshness lifecycle', () => {
  test('moves an idle live target through delayed, stale, signal_lost, then ended', async () => {
    const startMs = Date.parse('2026-01-01T00:00:00.000Z');
    const { tracker, bus, store, clock } = liveHarness(
      new QueueSource([[livePos(startMs)], [], [], [], []]),
      startMs,
    );

    await tracker.tick();
    expect((await store.all())[0]?.qualityState).toBe('live');

    clock.advance(16_000);
    await tracker.tick();
    expect((await store.all())[0]?.qualityState).toBe('delayed');

    clock.advance(15_000);
    await tracker.tick();
    expect((await store.all())[0]?.qualityState).toBe('stale');

    clock.advance(30_000);
    await tracker.tick();
    expect((await store.all())[0]?.qualityState).toBe('signal_lost');

    clock.advance(30_000);
    await tracker.tick();
    expect(await store.all()).toHaveLength(0);

    const c = counts(bus);
    expect(c.FlightDelayed).toBe(1);
    expect(c.FlightStale).toBe(1);
    expect(c.FlightSignalLost).toBe(1);
    expect(c.FlightEnded).toBe(1);
  });

  test('rejects live provider observations older than maxPositionAgeMs', async () => {
    const startMs = Date.parse('2026-01-01T00:00:00.000Z');
    const { tracker, bus, store } = liveHarness(
      new QueueSource([[livePos(startMs - DEFAULT_FLIGHT_LIFECYCLE_CONFIG.maxPositionAgeMs - 1)]]),
      startMs,
    );

    await tracker.tick();

    expect(await store.all()).toHaveLength(0);
    expect(bus.published).toHaveLength(0);
  });

  test('records rejection debug for duplicate live observations', async () => {
    const startMs = Date.parse('2026-01-01T00:00:00.000Z');
    const metrics = createTrackerMetrics();
    const { tracker, store } = liveHarness(
      new QueueSource([[livePos(startMs)], [livePos(startMs, { lat: 42 })]]),
      startMs,
      metrics,
    );

    await tracker.tick();
    await tracker.tick();

    const [state] = await store.all();
    expect(state?.lat).toBe(41);
    expect(state?.lastRejectedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(state?.rejectionReason).toBe('duplicate_timestamp');
    expect(state?.rejectionHistory?.[0]?.reason).toBe('duplicate_timestamp');
    expect(metrics.registry.render()).toContain(
      'tracker_observations_rejected_total{reason="duplicate_timestamp",source="test-live"} 1',
    );
  });
});
