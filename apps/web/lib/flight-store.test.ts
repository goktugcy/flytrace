import { describe, expect, test } from 'bun:test';
import { FlightStore, applyServerMessage } from './flight-store';

const pos = (flightId: string, lat: number, ts: string, over: Record<string, unknown> = {}) => ({
  flightId,
  icao24: 'abc123',
  lat,
  lon: 29,
  headingDeg: 90,
  altFt: 1000,
  gsKt: 100,
  onGround: false,
  ts,
  ...over,
});

describe('FlightStore', () => {
  test('applies and lists positions', () => {
    const s = new FlightStore();
    expect(s.applyPosition(pos('F1', 41, '2023-11-14T22:13:20.000Z'))).toBe(true);
    expect(s.size).toBe(1);
    expect(s.get('F1')?.lat).toBe(41);
  });

  test('keeps signal and source metadata from position updates', () => {
    const s = new FlightStore();
    expect(
      s.applyPosition(
        pos('F1', 41, '2023-11-14T22:13:20.000Z', {
          geoAltitudeFt: 1200,
          verticalRateFpm: -320,
          squawk: '7700',
          source: 'composite',
          sourceTimestamp: '2023-11-14T22:13:19.000Z',
          ageMs: 1000,
          quality: 0.82,
          positionSource: 'mlat',
          isMlat: true,
        }),
      ),
    ).toBe(true);
    expect(s.get('F1')).toMatchObject({
      geoAltitudeFt: 1200,
      verticalRateFpm: -320,
      squawk: '7700',
      source: 'composite',
      sourceTimestamp: '2023-11-14T22:13:19.000Z',
      ageMs: 1000,
      qualityScore: 0.82,
      positionSource: 'mlat',
      isMlat: true,
    });

    expect(
      s.applyPosition(
        pos('F1', 42, '2023-11-14T22:13:30.000Z', {
          geoAltitudeFt: null,
          verticalRateFpm: null,
          squawk: null,
          ageMs: null,
          qualityScore: null,
          positionSource: null,
          isMlat: null,
        }),
      ),
    ).toBe(true);
    expect(s.get('F1')).toMatchObject({
      geoAltitudeFt: null,
      verticalRateFpm: null,
      squawk: null,
      ageMs: null,
      qualityScore: null,
      positionSource: null,
      isMlat: null,
    });
  });

  test('guards against out-of-order deltas', () => {
    const s = new FlightStore();
    s.applyPosition(pos('F1', 41, '2023-11-14T22:13:20.000Z'));
    expect(s.applyPosition(pos('F1', 99, '2023-11-14T22:13:10.000Z'))).toBe(false); // older
    expect(s.applyPosition(pos('F1', 99, '2023-11-14T22:13:20.000Z'))).toBe(false); // duplicate
    expect(s.get('F1')?.lat).toBe(41); // unchanged
    expect(s.applyPosition(pos('F1', 42, '2023-11-14T22:13:30.000Z'))).toBe(true); // newer
    expect(s.get('F1')?.lat).toBe(42);
  });

  test('notifies subscribers on change', () => {
    const s = new FlightStore();
    let n = 0;
    s.subscribe(() => {
      n += 1;
    });
    s.applyPosition(pos('F1', 41, '2023-11-14T22:13:20.000Z'));
    s.applyPosition(pos('F1', 41, '2023-11-14T22:13:10.000Z')); // stale → no emit
    expect(n).toBe(1);
  });
});

describe('applyServerMessage', () => {
  test('seeds from a viewport snapshot array', () => {
    const s = new FlightStore();
    applyServerMessage(s, {
      t: 'snapshot',
      channel: 'viewport',
      data: [
        {
          flightId: 'F1',
          icao24: 'a',
          callsign: 'THY1',
          lat: 41,
          lon: 29,
          altFt: 1000,
          gsKt: 100,
          headingDeg: 90,
          lastTs: '2023-11-14T22:13:20.000Z',
        },
        {
          flightId: 'F2',
          icao24: 'b',
          callsign: null,
          lat: 40,
          lon: 30,
          altFt: 2000,
          gsKt: 200,
          headingDeg: 80,
          lastTs: '2023-11-14T22:13:20.000Z',
        },
      ],
    });
    expect(s.size).toBe(2);
    expect(s.get('F1')?.callsign).toBe('THY1');
  });

  test('reconciles authoritative viewport snapshots', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const s = new FlightStore({ now: () => now });
    s.applyPosition(pos('F1', 41, new Date(now).toISOString()));
    s.applyPosition(pos('F2', 40.5, new Date(now).toISOString()));
    s.applyPosition(pos('F3', 10, new Date(now).toISOString(), { lon: 10 }));

    now += 1000;
    applyServerMessage(s, {
      t: 'snapshot',
      channel: 'viewport',
      snapshotId: 'snap-1',
      sequence: 1,
      generatedAt: new Date(now).toISOString(),
      scope: { kind: 'viewport', bbox: [28, 40, 33, 42] },
      data: [
        {
          flightId: 'F1',
          icao24: 'a',
          callsign: 'THY1',
          lat: 41,
          lon: 29,
          altFt: 1000,
          gsKt: 100,
          headingDeg: 90,
          lastTs: '2026-01-01T00:00:00.000Z',
        },
      ],
    });

    expect(s.get('F1')).toBeDefined();
    expect(s.get('F2')).toBeUndefined();
    expect(s.get('F3')).toBeDefined(); // outside snapshot bbox
  });

  test('does not let an older snapshot remove a newer event', () => {
    const now = Date.parse('2026-01-01T00:00:05.000Z');
    const s = new FlightStore({ now: () => now });
    s.applyPosition(pos('F1', 41, new Date(now).toISOString()));

    applyServerMessage(s, {
      t: 'snapshot',
      channel: 'viewport',
      snapshotId: 'old-snap',
      sequence: 1,
      generatedAt: '2026-01-01T00:00:01.000Z',
      scope: { kind: 'viewport', bbox: [28, 40, 33, 42] },
      data: [],
    });

    expect(s.get('F1')).toBeDefined();
  });

  test('keeps supplemental ADS-B rows when tracker viewport snapshots reconcile', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const s = new FlightStore({ now: () => now });
    s.applySnapshotState({
      flightId: 'adsb:abc123',
      icao24: 'abc123',
      lat: 41,
      lon: 29,
      altFt: 10_000,
      gsKt: 250,
      lastTs: new Date(now).toISOString(),
    });

    now += 1000;
    applyServerMessage(s, {
      t: 'snapshot',
      channel: 'viewport',
      snapshotId: 'tracker-only-snapshot',
      generatedAt: new Date(now).toISOString(),
      scope: { kind: 'viewport', bbox: [28, 40, 33, 42] },
      data: [],
    });

    expect(s.get('adsb:abc123')).toBeDefined();
  });

  test('applies a PositionUpdated event and removes on FlightEnded', () => {
    const s = new FlightStore();
    applyServerMessage(s, {
      t: 'event',
      channel: 'viewport',
      id: '1-0',
      event: { type: 'PositionUpdated', payload: pos('F1', 41, '2023-11-14T22:13:20.000Z') },
    });
    expect(s.size).toBe(1);
    applyServerMessage(s, {
      t: 'event',
      channel: 'flight:F1',
      id: '2-0',
      event: { type: 'FlightEnded', payload: { flightId: 'F1' } },
    });
    expect(s.size).toBe(0);
  });

  test('ignores duplicate event ids', () => {
    const s = new FlightStore();
    const msg = {
      t: 'event',
      channel: 'viewport',
      id: '1-0',
      event: { type: 'PositionUpdated', payload: pos('F1', 41, '2023-11-14T22:13:20.000Z') },
    };
    applyServerMessage(s, msg);
    applyServerMessage(s, {
      ...msg,
      event: { type: 'PositionUpdated', payload: pos('F1', 99, '2023-11-14T22:13:30.000Z') },
    });
    expect(s.get('F1')?.lat).toBe(41);
  });

  test('updates quality from lifecycle events and prunes stale samples', () => {
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    let now = base;
    const s = new FlightStore({ now: () => now });
    s.applyPosition(pos('F1', 41, new Date(base).toISOString()));

    applyServerMessage(s, {
      t: 'event',
      channel: 'viewport',
      id: '2-0',
      event: { type: 'FlightStale', payload: { flightId: 'F1', state: 'stale' } },
    });
    expect(s.get('F1')?.qualityState).toBe('stale');

    now = base + 91_000;
    expect(s.pruneStale(now)).toBe(1);
    expect(s.size).toBe(0);
  });

  test('ignores unrelated / malformed messages', () => {
    const s = new FlightStore();
    applyServerMessage(s, { t: 'hello' });
    applyServerMessage(s, null);
    applyServerMessage(s, { t: 'event', event: { type: 'TakeoffDetected', payload: {} } });
    expect(s.size).toBe(0);
  });
});
