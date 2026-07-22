import { describe, expect, test } from 'bun:test';
import { contiguousTrailToAnchor } from './flight-trail';

describe('contiguousTrailToAnchor', () => {
  test('keeps a plausible recent trail and appends the live position', () => {
    const coords = contiguousTrailToAnchor(
      [
        { ts: '2026-07-22T12:00:00Z', lat: 40, lon: 28 },
        { ts: '2026-07-22T12:05:00Z', lat: 40.3, lon: 28.4 },
      ],
      { ts: '2026-07-22T12:10:00Z', lat: 40.6, lon: 28.8 },
    );
    expect(coords).toEqual([
      [28, 40],
      [28.4, 40.3],
      [28.8, 40.6],
    ]);
  });

  test('rejects a previous flight separated by hours from the live aircraft', () => {
    expect(
      contiguousTrailToAnchor(
        [
          { ts: '2026-07-22T03:36:25Z', lat: 38.5063, lon: 30.9631 },
          { ts: '2026-07-22T03:36:30Z', lat: 38.5113, lon: 30.9528 },
        ],
        { ts: '2026-07-22T12:47:50Z', lat: 40.9, lon: 29.3 },
      ),
    ).toEqual([]);
  });

  test('rejects an impossible jump even when timestamps are close', () => {
    expect(
      contiguousTrailToAnchor(
        [
          { ts: '2026-07-22T12:00:00Z', lat: 40, lon: 28 },
          { ts: '2026-07-22T12:01:00Z', lat: 35, lon: 34 },
        ],
        { ts: '2026-07-22T12:02:00Z', lat: 40.2, lon: 28.2 },
      ),
    ).toEqual([]);
  });

  test('keeps only the latest segment after an internal outage', () => {
    const coords = contiguousTrailToAnchor(
      [
        { ts: '2026-07-22T11:00:00Z', lat: 38, lon: 27 },
        { ts: '2026-07-22T12:00:00Z', lat: 40, lon: 28 },
        { ts: '2026-07-22T12:05:00Z', lat: 40.3, lon: 28.4 },
      ],
      { ts: '2026-07-22T12:10:00Z', lat: 40.6, lon: 28.8 },
    );
    expect(coords[0]).toEqual([28, 40]);
    expect(coords).toHaveLength(3);
  });
});
