import type { Airspace, AirspaceGeometry, AirspaceType } from '@flytrace/airspace';
import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

export interface AirspaceReadFilter {
  provider?: string | undefined;
  datasetVersion?: string | undefined;
}

interface AirspaceRow {
  id: string;
  name: string;
  type: AirspaceType;
  icaoClass: string | null;
  lowerFt: number | null;
  upperFt: number | null;
  frequency: string | null;
  geojson: AirspaceGeometry;
  provider: string | null;
  sourceId: string | null;
  datasetVersion: string | null;
}

export function createAirspaceReadRepo(db: Database) {
  return {
    async listActive(filter: AirspaceReadFilter = {}): Promise<Airspace[]> {
      const clauses = [sql`effective_to is null`, sql`geojson is not null`];
      if (filter.provider) clauses.push(sql`provider = ${filter.provider}`);
      if (filter.datasetVersion) clauses.push(sql`dataset_version = ${filter.datasetVersion}`);

      const rows = (await db.execute(sql`
        select id, name, type, icao_class as "icaoClass", lower_ft as "lowerFt",
               upper_ft as "upperFt", frequency, geojson,
               provider, source_id as "sourceId", dataset_version as "datasetVersion"
        from geofences
        where ${sql.join(clauses, sql` and `)}
        order by provider nulls last, dataset_version desc nulls last, name
      `)) as unknown as AirspaceRow[];

      return rows.map((row) => ({
        id: row.sourceId ?? row.id,
        name: row.name,
        type: row.type,
        icaoClass: row.icaoClass,
        lowerFt: row.lowerFt,
        upperFt: row.upperFt,
        frequency: row.frequency,
        source: row.provider ?? 'db',
        sourceId: row.sourceId ?? row.id,
        polygon: row.geojson,
        ...(row.provider ? { provider: row.provider } : {}),
        ...(row.datasetVersion ? { datasetVersion: row.datasetVersion } : {}),
      }));
    },
  };
}

export type AirspaceReadRepo = ReturnType<typeof createAirspaceReadRepo>;
