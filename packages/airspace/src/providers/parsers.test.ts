import { describe, expect, test } from 'bun:test';
import { aixmLimitToFt, normalizeAixmBlock, parseAixmDataset, parsePosList } from './aixm.ts';
import { normalizeOpenAipRecord, parseOpenAipDataset } from './openaip.ts';
import { normalizeOfmFeature, parseOfmAltitude, parseOfmDataset } from './openflightmaps.ts';

const polygon = {
  type: 'Polygon' as const,
  coordinates: [
    [
      [28, 40],
      [30, 40],
      [30, 42],
      [28, 42],
      [28, 40],
    ],
  ],
};

describe('openAIP parser', () => {
  test('normalizes a native record with numeric type/class codes', () => {
    const a = normalizeOpenAipRecord({
      _id: 'x1',
      name: 'ISTANBUL CTR',
      type: 4, // CTR
      icaoClass: 3, // D
      lowerLimit: { value: 0, unit: 1 },
      upperLimit: { value: 245, unit: 6 }, // FL245
      frequency: { value: '129.300' },
      geometry: polygon,
    });
    expect(a).not.toBeNull();
    expect(a?.type).toBe('CTR');
    expect(a?.icaoClass).toBe('D');
    expect(a?.lowerFt).toBe(0);
    expect(a?.upperFt).toBe(24500);
    expect(a?.frequency).toBe('129.300');
    expect(a?.source).toBe('openaip');
  });

  test('accepts a GeoJSON Feature and falls back to name-based type', () => {
    const a = normalizeOpenAipRecord({
      type: 'Feature',
      properties: { name: 'ANKARA TMA' },
      geometry: polygon,
    });
    expect(a?.type).toBe('TMA');
    expect(a?.name).toBe('ANKARA TMA');
  });

  test('records without geometry are skipped', () => {
    expect(normalizeOpenAipRecord({ name: 'no geom' })).toBeNull();
  });

  test('parseOpenAipDataset reads a FeatureCollection', () => {
    const text = JSON.stringify({
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: { name: 'A FIR' }, geometry: polygon }],
    });
    const out = parseOpenAipDataset(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('FIR');
  });

  test('un-configured / invalid dataset degrades to empty', () => {
    expect(parseOpenAipDataset(null)).toEqual([]);
    expect(parseOpenAipDataset('{ not json')).toEqual([]);
  });
});

describe('open-flightmaps parser', () => {
  test('parseOfmAltitude handles GND / UNL / FL / plain feet', () => {
    expect(parseOfmAltitude('GND')).toBe(0);
    expect(parseOfmAltitude('UNL')).toBeNull();
    expect(parseOfmAltitude('FL245')).toBe(24500);
    expect(parseOfmAltitude('2500 FT AGL')).toBe(2500);
    expect(parseOfmAltitude('1000FT MSL')).toBe(1000);
    expect(parseOfmAltitude(null)).toBeNull();
  });

  test('normalizes a feature with string vertical limits', () => {
    const a = normalizeOfmFeature({
      type: 'Feature',
      id: 7,
      properties: {
        name: 'IST CTR',
        type: 'CTR',
        class: 'D',
        lower: 'GND',
        upper: 'FL100',
        frequency: 129.3,
      },
      geometry: polygon,
    });
    expect(a?.id).toBe('ofm:7');
    expect(a?.type).toBe('CTR');
    expect(a?.icaoClass).toBe('D');
    expect(a?.lowerFt).toBe(0);
    expect(a?.upperFt).toBe(10000);
    expect(a?.frequency).toBe('129.3');
  });

  test('parseOfmDataset reads a FeatureCollection and skips geometry-less features', () => {
    const text = JSON.stringify({
      features: [
        { type: 'Feature', properties: { name: 'X', type: 'TMA' }, geometry: polygon },
        { type: 'Feature', properties: { name: 'Y' } },
      ],
    });
    expect(parseOfmDataset(text)).toHaveLength(1);
  });
});

describe('AIXM parser', () => {
  test('parsePosList reads lat/lon pairs as [lon,lat] and closes the ring', () => {
    const ring = parsePosList('40 28 40 30 42 30 42 28');
    expect(ring[0]).toEqual([28, 40]);
    expect(ring[1]).toEqual([30, 40]);
    // auto-closed
    expect(ring[ring.length - 1]).toEqual(ring[0]);
  });

  test('aixmLimitToFt handles FL, feet, GND and UNL', () => {
    expect(aixmLimitToFt('245', 'FL')).toBe(24500);
    expect(aixmLimitToFt('1000', 'FT')).toBe(1000);
    expect(aixmLimitToFt('GND', null)).toBe(0);
    expect(aixmLimitToFt('UNL', null)).toBeNull();
    expect(aixmLimitToFt(null, null)).toBeNull();
  });

  test('normalizeAixmBlock extracts name, type, class, limits and geometry', () => {
    const block = `<aixm:Airspace gml:id="as-1">
      <aixm:name>ISTANBUL FIR</aixm:name>
      <aixm:type>FIR</aixm:type>
      <aixm:class>A</aixm:class>
      <aixm:lowerLimit uom="FT">0</aixm:lowerLimit>
      <aixm:upperLimit uom="FL">245</aixm:upperLimit>
      <gml:posList>40 28 40 30 42 30 42 28</gml:posList>
    </aixm:Airspace>`;
    const a = normalizeAixmBlock(block, 0);
    expect(a?.id).toBe('as-1');
    expect(a?.name).toBe('ISTANBUL FIR');
    expect(a?.type).toBe('FIR');
    expect(a?.icaoClass).toBe('A');
    expect(a?.lowerFt).toBe(0);
    expect(a?.upperFt).toBe(24500);
    expect(a?.polygon.type).toBe('Polygon');
  });

  test('parseAixmDataset extracts every Airspace block; empty input → []', () => {
    const doc = `<root>
      <aixm:Airspace gml:id="a"><gml:posList>40 28 40 30 42 30</gml:posList></aixm:Airspace>
      <aixm:Airspace gml:id="b"><gml:posList>10 10 10 12 12 12</gml:posList></aixm:Airspace>
    </root>`;
    expect(parseAixmDataset(doc)).toHaveLength(2);
    expect(parseAixmDataset(null)).toEqual([]);
  });
});
