import { describe, expect, test } from 'bun:test';
import { loadRootEnv } from '@flytrace/shared';
import { createDb, sql } from '../index.ts';
import { createAirspaceImportRepo } from './airspace-import.ts';

loadRootEnv();

const url = process.env.DATABASE_URL;
const maybe = url ? describe : describe.skip;

const polygon = {
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
};

const bowtie = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
      [0, 0],
    ],
  ],
};

maybe('createAirspaceImportRepo', () => {
  test('validates geometry with PostGIS and upserts by provider/version/source id', async () => {
    const { db, close } = createDb({ url: url as string, max: 1 });
    const repo = createAirspaceImportRepo(db);
    try {
      await db.execute(sql`delete from geofences where provider = 'fixture-db'`);
      expect((await repo.validateGeometry(polygon)).valid).toBe(true);
      const invalid = await repo.validateGeometry(bowtie);
      expect(invalid.valid).toBe(false);
      expect(invalid.reason).toBeTruthy();

      const importedAt = new Date('2026-07-19T00:00:00.000Z');
      await repo.upsertBatch([
        {
          provider: 'fixture-db',
          sourceId: 'a1',
          datasetVersion: 'v1',
          importedAt,
          effectiveFrom: importedAt,
          effectiveTo: null,
          name: 'Restricted A',
          type: 'RESTRICTED',
          icaoClass: null,
          lowerFt: 0,
          upperFt: 5000,
          frequency: null,
          geojson: polygon,
        },
      ]);
      await repo.upsertBatch([
        {
          provider: 'fixture-db',
          sourceId: 'a1',
          datasetVersion: 'v1',
          importedAt,
          effectiveFrom: importedAt,
          effectiveTo: null,
          name: 'Restricted A Updated',
          type: 'RESTRICTED',
          icaoClass: null,
          lowerFt: 0,
          upperFt: 6000,
          frequency: null,
          geojson: polygon,
        },
      ]);

      const rows = (await db.execute(sql`
        select name, upper_ft as "upperFt"
        from geofences
        where provider = 'fixture-db' and dataset_version = 'v1' and source_id = 'a1'
      `)) as unknown as Array<{ name: string; upperFt: number | null }>;
      expect(rows).toEqual([{ name: 'Restricted A Updated', upperFt: 6000 }]);

      await repo.upsertBatch([
        {
          provider: 'fixture-db',
          sourceId: 'old',
          datasetVersion: 'v0',
          importedAt,
          effectiveFrom: importedAt,
          effectiveTo: null,
          name: 'Old',
          type: 'FIR',
          icaoClass: null,
          lowerFt: null,
          upperFt: null,
          frequency: null,
          geojson: polygon,
        },
      ]);
      expect(await repo.retirePreviousVersions('fixture-db', 'v1', importedAt)).toBe(1);
    } finally {
      await db.execute(sql`delete from geofences where provider = 'fixture-db'`);
      await close();
    }
  });
});
