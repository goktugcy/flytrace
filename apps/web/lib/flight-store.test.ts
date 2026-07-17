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

  test('guards against out-of-order deltas', () => {
    const s = new FlightStore();
    s.applyPosition(pos('F1', 41, '2023-11-14T22:13:20.000Z'));
    expect(s.applyPosition(pos('F1', 99, '2023-11-14T22:13:10.000Z'))).toBe(false); // older
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

  test('ignores unrelated / malformed messages', () => {
    const s = new FlightStore();
    applyServerMessage(s, { t: 'hello' });
    applyServerMessage(s, null);
    applyServerMessage(s, { t: 'event', event: { type: 'TakeoffDetected', payload: {} } });
    expect(s.size).toBe(0);
  });
});
