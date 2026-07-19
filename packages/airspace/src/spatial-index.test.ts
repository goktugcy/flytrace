import { describe, expect, test } from 'bun:test';
import { SpatialIndex } from './spatial-index.ts';
import type { Airspace } from './types.ts';

function box(id: string, minLon: number, minLat: number, maxLon: number, maxLat: number): Airspace {
  return {
    id,
    name: id,
    type: 'TMA',
    icaoClass: null,
    lowerFt: null,
    upperFt: null,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  };
}

describe('SpatialIndex', () => {
  test('build records size', () => {
    const idx = SpatialIndex.build([box('a', 0, 0, 1, 1), box('b', 10, 10, 11, 11)]);
    expect(idx.size).toBe(2);
  });

  test('findContaining returns only the box that contains the point', () => {
    const idx = SpatialIndex.build([box('a', 0, 0, 5, 5), box('b', 10, 10, 15, 15)]);
    expect(idx.findContaining(2, 2).map((a) => a.id)).toEqual(['a']);
    expect(idx.findContaining(12, 12).map((a) => a.id)).toEqual(['b']);
    expect(idx.findContaining(8, 8)).toEqual([]);
  });

  test('overlapping boxes both match and results are de-duplicated', () => {
    const idx = SpatialIndex.build([box('big', 0, 0, 20, 20), box('small', 5, 5, 10, 10)]);
    const ids = idx
      .findContaining(7, 7)
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(['big', 'small']);
  });

  test('a box spanning many cells is still found (multi-cell bucketing)', () => {
    // With the default 1° grid this box spans ~25 cells; the query point sits in
    // an interior cell, exercising cellKeysForBbox coverage.
    const idx = SpatialIndex.build([box('wide', 0, 0, 5, 5)]);
    expect(idx.findContaining(3.5, 2.5).map((a) => a.id)).toEqual(['wide']);
  });

  test('a smaller cell size still resolves containment', () => {
    const idx = SpatialIndex.build([box('a', 0, 0, 1, 1)], { cellDeg: 0.25 });
    expect(idx.findContaining(0.5, 0.5).map((a) => a.id)).toEqual(['a']);
    expect(idx.findContaining(2, 2)).toEqual([]);
  });
});
