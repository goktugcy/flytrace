import { describe, expect, test } from 'bun:test';
import { createLogger, fixedClock } from '@flytrace/shared';
import type { Position } from '../domain/position.ts';
import { CompositePositionSource } from './composite-source.ts';
import type { PositionSource } from './port.ts';

class QueueSource implements PositionSource {
  readonly timeMode = 'wall';

  constructor(
    readonly name: string,
    private readonly frames: (Position[] | Error)[],
  ) {}

  async poll(): Promise<Position[]> {
    const frame = this.frames.shift() ?? [];
    if (frame instanceof Error) throw frame;
    return frame;
  }
}

const START_MS = Date.parse('2026-01-01T00:00:00.000Z');

function pos(over: Partial<Position> = {}): Position {
  const ts = over.ts ?? new Date(START_MS - 1000).toISOString();
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
    ts,
    sourceTimestamp: ts,
    positionSource: 'adsb',
    isMlat: false,
    ...over,
  };
}

function hasCandidate(
  candidates: unknown[] | undefined,
  provider: string,
  selected?: boolean,
  rejectionReason?: string,
): boolean {
  return (candidates ?? []).some((candidate) => {
    if (!candidate || typeof candidate !== 'object') return false;
    const record = candidate as Record<string, unknown>;
    return (
      record.provider === provider &&
      (selected === undefined || record.selected === selected) &&
      (rejectionReason === undefined || record.rejectionReason === rejectionReason)
    );
  });
}

function source(
  sources: PositionSource[],
  over: Partial<ConstructorParameters<typeof CompositePositionSource>[0]> = {},
) {
  const clock = fixedClock(START_MS);
  return new CompositePositionSource({
    sources,
    logger: createLogger({ level: 'error', base: {} }),
    clock,
    maxPositionAgeMs: 30_000,
    switchMargin: 0.15,
    maxJumpSpeedKt: 1200,
    providerPriority: { adsb: 20, opensky: 10 },
    ...over,
  });
}

describe('CompositePositionSource', () => {
  test('passes through OpenSky-only observations', async () => {
    const composite = source([new QueueSource('opensky', [[pos()]])]);
    const out = await composite.poll();
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('opensky');
  });

  test('passes through ADS-B-only observations', async () => {
    const composite = source([new QueueSource('adsb', [[pos()]])]);
    const out = await composite.poll();
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('adsb');
  });

  test('deduplicates by ICAO24 and chooses the fresher provider', async () => {
    const composite = source([
      new QueueSource('opensky', [[pos({ ts: new Date(START_MS - 10_000).toISOString() })]]),
      new QueueSource('adsb', [[pos({ ts: new Date(START_MS - 1000).toISOString() })]]),
    ]);

    const out = await composite.poll();

    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('adsb');
  });

  test('rejects stale provider candidates and keeps a fresh candidate', async () => {
    const composite = source([
      new QueueSource('opensky', [[pos({ ts: new Date(START_MS - 31_000).toISOString() })]]),
      new QueueSource('adsb', [[pos({ ts: new Date(START_MS - 1000).toISOString() })]]),
    ]);

    const out = await composite.poll();

    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('adsb');
    expect(out[0]?.candidateProviders).toEqual(['adsb', 'opensky']);
    expect(hasCandidate(out[0]?.providerCandidates, 'opensky', false, 'stale_observation')).toBe(
      true,
    );
  });

  test('isolates a failed provider poll', async () => {
    const composite = source([
      new QueueSource('opensky', [new Error('timeout')]),
      new QueueSource('adsb', [[pos()]]),
    ]);

    const out = await composite.poll();

    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('adsb');
  });

  test('hysteresis prevents small-score provider oscillation', async () => {
    const composite = source(
      [
        new QueueSource('adsb', [[pos()], [pos()]]),
        new QueueSource('opensky', [[], [pos({ positionSource: 'adsb' })]]),
      ],
      { providerPriority: { adsb: 0, opensky: 10 } },
    );

    expect((await composite.poll())[0]?.source).toBe('adsb');
    expect((await composite.poll())[0]?.source).toBe('adsb');
  });

  test('switches provider when the selected provider disappears', async () => {
    const composite = source([
      new QueueSource('adsb', [[pos()], []]),
      new QueueSource('opensky', [[], [pos({ ts: new Date(START_MS + 1000).toISOString() })]]),
    ]);

    expect((await composite.poll())[0]?.source).toBe('adsb');
    expect((await composite.poll())[0]?.source).toBe('opensky');
  });

  test('rejects an impossible position jump', async () => {
    const composite = source([
      new QueueSource('adsb', [[pos()], []]),
      new QueueSource('opensky', [
        [],
        [
          pos({
            ts: new Date(START_MS + 1000).toISOString(),
            lat: 0,
            lon: 0,
          }),
        ],
      ]),
    ]);

    expect(await composite.poll()).toHaveLength(1);
    expect(await composite.poll()).toHaveLength(0);
  });

  test('uses ICAO24 as the dedupe key even when callsigns differ', async () => {
    const composite = source([
      new QueueSource('opensky', [[pos({ callsign: 'THY1' })]]),
      new QueueSource('adsb', [[pos({ callsign: 'THY2' })]]),
    ]);

    const out = await composite.poll();

    expect(out).toHaveLength(1);
    expect(out[0]?.icao24).toBe('4bb1a2');
    expect(hasCandidate(out[0]?.providerCandidates, 'opensky')).toBe(true);
    expect(hasCandidate(out[0]?.providerCandidates, 'adsb')).toBe(true);
  });
});
