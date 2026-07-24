import { describe, expect, test } from 'bun:test';
import {
  type OverpassElement,
  buildOverpassQuery,
  parseOverpassAeroway,
} from './import-airport-osm.ts';

const elements: OverpassElement[] = [
  {
    type: 'way',
    id: 1,
    tags: { aeroway: 'runway', ref: '16L/34R' },
    geometry: [
      { lat: 41.0, lon: 28.7 },
      { lat: 41.05, lon: 28.75 },
    ],
  },
  {
    type: 'way',
    id: 2,
    tags: { aeroway: 'taxiway', ref: 'A' },
    geometry: [
      { lat: 41.0, lon: 28.7 },
      { lat: 41.01, lon: 28.71 },
      { lat: 41.02, lon: 28.72 },
    ],
  },
  {
    type: 'way',
    id: 3,
    tags: { aeroway: 'apron' },
    geometry: [
      { lat: 41.0, lon: 28.7 },
      { lat: 41.0, lon: 28.72 },
      { lat: 41.02, lon: 28.72 },
      // not explicitly closed → parser should close the ring
    ],
  },
  { type: 'node', id: 4, lat: 41.0, lon: 28.7, tags: { aeroway: 'gate', ref: 'A12' } },
  { type: 'way', id: 5, tags: { aeroway: 'highway' }, geometry: [{ lat: 1, lon: 1 }] }, // ignored
];

describe('parseOverpassAeroway', () => {
  const parsed = parseOverpassAeroway(elements);

  test('keeps only aeroway features we model', () => {
    expect(parsed.map((f) => f.kind).sort()).toEqual(['apron', 'gate', 'runway', 'taxiway']);
  });

  test('runway/taxiway → LINESTRING, apron → closed POLYGON, gate → POINT', () => {
    const runway = parsed.find((f) => f.kind === 'runway');
    expect(runway?.ewkt).toBe('SRID=4326;LINESTRING(28.7 41, 28.75 41.05)');
    expect(runway?.ref).toBe('16L/34R');

    const apron = parsed.find((f) => f.kind === 'apron');
    expect(apron?.ewkt.startsWith('SRID=4326;POLYGON((')).toBe(true);
    // ring is closed: first point repeated at the end
    expect(apron?.ewkt.endsWith('28.7 41))')).toBe(true);

    const gate = parsed.find((f) => f.kind === 'gate');
    expect(gate?.ewkt).toBe('SRID=4326;POINT(28.7 41)');
    expect(gate?.osmId).toBe('node/4');
  });

  test('skips ways without enough geometry', () => {
    expect(parseOverpassAeroway([{ type: 'way', id: 9, tags: { aeroway: 'taxiway' } }])).toEqual(
      [],
    );
  });
});

describe('buildOverpassQuery', () => {
  test('scopes aeroway to a radius around the airport', () => {
    const q = buildOverpassQuery(41.26, 28.74, 6000);
    expect(q).toContain('way["aeroway"](around:6000,41.26,28.74)');
    expect(q).toContain('out geom;');
  });
});
