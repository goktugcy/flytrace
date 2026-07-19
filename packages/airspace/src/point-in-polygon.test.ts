import { describe, expect, test } from 'bun:test';
import {
  geometryBbox,
  pointInBbox,
  pointInGeometry,
  pointInPolygonRings,
  pointInRing,
} from './point-in-polygon.ts';
import type { GeoJsonMultiPolygon, GeoJsonPolygon, LinearRing } from './types.ts';

// A 10×10 square from (0,0) to (10,10), closed ring in [lon,lat].
const square: LinearRing = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];

describe('pointInRing', () => {
  test('interior point is inside', () => {
    expect(pointInRing(5, 5, square)).toBe(true);
  });

  test('exterior point is outside', () => {
    expect(pointInRing(15, 5, square)).toBe(false);
    expect(pointInRing(-1, 5, square)).toBe(false);
    expect(pointInRing(5, 20, square)).toBe(false);
  });

  test('boundary point (on edge) is inside', () => {
    expect(pointInRing(0, 5, square)).toBe(true); // left edge
    expect(pointInRing(5, 0, square)).toBe(true); // bottom edge
    expect(pointInRing(10, 10, square)).toBe(true); // corner
  });

  test('degenerate ring (<3 pts) is never inside', () => {
    expect(
      pointInRing(0, 0, [
        [0, 0],
        [1, 1],
      ]),
    ).toBe(false);
  });

  test('concave polygon (L-shape) respects the notch', () => {
    const lshape: LinearRing = [
      [0, 0],
      [10, 0],
      [10, 4],
      [4, 4],
      [4, 10],
      [0, 10],
      [0, 0],
    ];
    expect(pointInRing(2, 2, lshape)).toBe(true);
    expect(pointInRing(8, 8, lshape)).toBe(false); // in the removed corner
  });
});

describe('pointInPolygonRings (holes)', () => {
  const withHole: LinearRing[] = [
    square,
    // hole from (3,3) to (7,7)
    [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ],
  ];

  test('inside outer but outside hole → inside', () => {
    expect(pointInPolygonRings(1, 1, withHole)).toBe(true);
  });

  test('inside the hole → outside', () => {
    expect(pointInPolygonRings(5, 5, withHole)).toBe(false);
  });

  test('empty rings → outside', () => {
    expect(pointInPolygonRings(5, 5, [])).toBe(false);
  });
});

describe('pointInGeometry', () => {
  const polygon: GeoJsonPolygon = { type: 'Polygon', coordinates: [square] };
  const multi: GeoJsonMultiPolygon = {
    type: 'MultiPolygon',
    coordinates: [
      [square],
      [
        [
          [20, 20],
          [30, 20],
          [30, 30],
          [20, 30],
          [20, 20],
        ],
      ],
    ],
  };

  test('Polygon containment', () => {
    expect(pointInGeometry(5, 5, polygon)).toBe(true);
    expect(pointInGeometry(50, 50, polygon)).toBe(false);
  });

  test('MultiPolygon matches either sub-polygon', () => {
    expect(pointInGeometry(5, 5, multi)).toBe(true);
    expect(pointInGeometry(25, 25, multi)).toBe(true);
    expect(pointInGeometry(15, 15, multi)).toBe(false); // gap between them
  });

  test('bbox pre-check short-circuits far points', () => {
    expect(pointInGeometry(1000, 1000, polygon)).toBe(false);
  });
});

describe('geometryBbox & pointInBbox', () => {
  test('bbox of the square', () => {
    const polygon: GeoJsonPolygon = { type: 'Polygon', coordinates: [square] };
    expect(geometryBbox(polygon)).toEqual([0, 0, 10, 10]);
  });

  test('multipolygon bbox spans all rings', () => {
    const multi: GeoJsonMultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [
        [square],
        [
          [
            [20, 20],
            [30, 30],
            [20, 30],
            [20, 20],
          ],
        ],
      ],
    };
    expect(geometryBbox(multi)).toEqual([0, 0, 30, 30]);
  });

  test('pointInBbox inclusive edges', () => {
    expect(pointInBbox(0, 0, [0, 0, 10, 10])).toBe(true);
    expect(pointInBbox(11, 5, [0, 0, 10, 10])).toBe(false);
  });
});
