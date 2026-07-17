import { describe, expect, test } from 'bun:test';
import { normalizeStateVector, normalizeStatesResponse } from './position.ts';

describe('normalizeStateVector', () => {
  const base: unknown[] = [
    '4BB1A2',
    'THY1TG  ',
    'Turkey',
    1700000000,
    1700000000,
    28.74,
    41.26,
    1000, // baro_altitude m
    false,
    100, // velocity m/s
    130, // track
    10, // vertical rate m/s
  ];

  test('converts units and trims callsign', () => {
    const p = normalizeStateVector(base);
    expect(p).not.toBeNull();
    expect(p?.icao24).toBe('4bb1a2'); // lowercased
    expect(p?.callsign).toBe('THY1TG'); // trimmed
    expect(p?.lat).toBe(41.26);
    expect(p?.lon).toBe(28.74);
    expect(p?.altFt).toBe(3281); // 1000 m → ft, rounded
    expect(p?.gsKt).toBe(194.4); // 100 m/s → kt
    expect(p?.vrateFpm).toBe(1969); // 10 m/s → fpm
    expect(p?.onGround).toBe(false);
    expect(p?.ts).toBe('2023-11-14T22:13:20.000Z');
  });

  test('returns null when position is missing', () => {
    const noPos = [...base];
    noPos[5] = null; // lon
    noPos[6] = null; // lat
    expect(normalizeStateVector(noPos)).toBeNull();
  });

  test('preserves unknown numeric fields as null (never fabricated)', () => {
    const partial = [...base];
    partial[7] = null; // baro_altitude
    partial[9] = null; // velocity
    partial[11] = null; // vertical_rate
    const p = normalizeStateVector(partial);
    expect(p?.altFt).toBeNull();
    expect(p?.gsKt).toBeNull();
    expect(p?.vrateFpm).toBeNull();
  });

  test('rejects malformed vectors', () => {
    expect(normalizeStateVector(['only', 'two'])).toBeNull();
    expect(normalizeStateVector(null)).toBeNull();
  });
});

describe('normalizeStatesResponse', () => {
  test('drops unplaceable rows and keeps the rest', () => {
    const res = {
      time: 1700000000,
      states: [
        ['a', 'X ', 'C', 1700000000, 1700000000, 10, 20, 0, true, 0, 0, 0],
        ['b', 'Y ', 'C', 1700000000, 1700000000, null, null, 0, true, 0, 0, 0], // no pos
      ],
    };
    const out = normalizeStatesResponse(res);
    expect(out).toHaveLength(1);
    expect(out[0]?.icao24).toBe('a');
  });

  test('handles empty/null states', () => {
    expect(normalizeStatesResponse({ time: 1, states: null })).toEqual([]);
    expect(normalizeStatesResponse({ nope: true })).toEqual([]);
  });
});
