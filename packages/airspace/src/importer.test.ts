import { describe, expect, test } from 'bun:test';
import type { AirspaceImportRepository, AirspaceImportRow } from './importer.ts';
import { importAirspaceDataset, validateAirspaceGeometryShape } from './importer.ts';
import type { Airspace } from './types.ts';

function airspace(id: string, name = id): Airspace {
  return {
    id,
    sourceId: id,
    provider: 'fixture',
    name,
    type: 'RESTRICTED',
    icaoClass: null,
    lowerFt: 0,
    upperFt: 5000,
    frequency: null,
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [28, 40],
          [29, 40],
          [29, 41],
          [28, 41],
          [28, 40],
        ],
      ],
    },
  };
}

class FakeImportRepo implements AirspaceImportRepository {
  readonly batches: AirspaceImportRow[][] = [];
  retiredPrevious = 0;
  retiredMissing = 0;

  async validateGeometry(geometry: Airspace['polygon']) {
    if (geometry.type === 'Polygon' && geometry.coordinates[0]?.[0]?.[0] === 0) {
      return { valid: false, reason: 'Self-intersection' };
    }
    return { valid: true };
  }

  async upsertBatch(rows: AirspaceImportRow[]) {
    this.batches.push(rows);
    return rows.length;
  }

  async retirePreviousVersions() {
    this.retiredPrevious += 2;
    return 2;
  }

  async retireMissing() {
    this.retiredMissing += 1;
    return 1;
  }
}

describe('validateAirspaceGeometryShape', () => {
  test('rejects unclosed rings before PostGIS validation', () => {
    const a = airspace('bad');
    a.polygon.coordinates[0] = [
      [28, 40],
      [29, 40],
      [29, 41],
      [28, 41],
    ];
    expect(validateAirspaceGeometryShape(a.polygon)).toBe('ring is not closed');
  });
});

describe('importAirspaceDataset', () => {
  test('validates, batches, upserts idempotent rows, and reports invalid polygons', async () => {
    const repo = new FakeImportRepo();
    const invalid = airspace('invalid-postgis');
    invalid.polygon.coordinates[0] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const result = await importAirspaceDataset(
      repo,
      [airspace('a1'), airspace('a2'), airspace('a2', 'duplicate'), invalid],
      {
        provider: 'fixture',
        datasetVersion: '2026-07-19',
        importedAt: new Date('2026-07-19T00:00:00.000Z'),
        batchSize: 1,
        retirePreviousVersions: true,
        retireMissing: true,
      },
    );

    expect(result.upserted).toBe(2);
    expect(repo.batches).toHaveLength(2);
    expect(repo.batches[0]?.[0]?.sourceId).toBe('a1');
    expect(result.retired).toBe(3);
    expect(result.invalid.map((r) => r.reason)).toEqual([
      'duplicate source id in dataset',
      'Self-intersection',
    ]);
    expect(repo.batches[0]?.[0]?.datasetVersion).toBe('2026-07-19');
  });
});
