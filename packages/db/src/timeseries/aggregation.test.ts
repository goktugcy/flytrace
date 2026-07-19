import { describe, expect, test } from 'bun:test';
import { type TrailPoint, downsampleByTime, simplifyTrail, toEpochMs } from './aggregation.ts';

describe('toEpochMs', () => {
  test('passes through numbers', () => {
    expect(toEpochMs(1000)).toBe(1000);
  });

  test('parses Date and ISO string identically', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(toEpochMs(d)).toBe(d.getTime());
    expect(toEpochMs('2026-01-01T00:00:00.000Z')).toBe(d.getTime());
  });
});

describe('downsampleByTime', () => {
  test('rejects non-positive bucket width', () => {
    expect(() => downsampleByTime([{ ts: 0 }], 0)).toThrow();
  });

  test('returns input for 0/1 element arrays', () => {
    expect(downsampleByTime([], 1000)).toEqual([]);
    expect(downsampleByTime([{ ts: 5 }], 1000)).toEqual([{ ts: 5 }]);
  });

  test('keeps the last sample in each bucket', () => {
    const pts = [
      { ts: 0, v: 'a' },
      { ts: 400, v: 'b' },
      { ts: 900, v: 'c' }, // still bucket 0 (width 1000)
      { ts: 1200, v: 'd' }, // bucket 1
      { ts: 2500, v: 'e' }, // bucket 2
    ];
    const out = downsampleByTime(pts, 1000);
    expect(out.map((p) => p.v)).toEqual(['c', 'd', 'e']);
  });

  test('does not mutate the input', () => {
    const pts = [{ ts: 0 }, { ts: 10 }];
    const copy = [...pts];
    downsampleByTime(pts, 1000);
    expect(pts).toEqual(copy);
  });
});

describe('simplifyTrail', () => {
  const straight: TrailPoint[] = [
    { ts: 0, lat: 0, lon: 0 },
    { ts: 1, lat: 0, lon: 1 },
    { ts: 2, lat: 0, lon: 2 },
    { ts: 3, lat: 0, lon: 3 },
  ];

  test('returns input when tolerance <= 0 or <= 2 points', () => {
    expect(simplifyTrail(straight, 0)).toHaveLength(4);
    expect(simplifyTrail(straight.slice(0, 2), 0.5)).toHaveLength(2);
  });

  test('collapses a straight line to its endpoints', () => {
    const out = simplifyTrail(straight, 0.01);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(straight[0] as TrailPoint);
    expect(out[out.length - 1]).toEqual(straight[3] as TrailPoint);
  });

  test('retains a point that deviates beyond tolerance', () => {
    const bent: TrailPoint[] = [
      { ts: 0, lat: 0, lon: 0 },
      { ts: 1, lat: 1, lon: 1 }, // significant deviation from the 0,0 -> 0,2 chord
      { ts: 2, lat: 0, lon: 2 },
    ];
    const out = simplifyTrail(bent, 0.1);
    expect(out).toHaveLength(3);
  });

  test('preserves original ordering and endpoints', () => {
    const out = simplifyTrail(straight, 0.01);
    expect(out[0]?.ts).toBe(0);
    expect(out[out.length - 1]?.ts).toBe(3);
  });
});
