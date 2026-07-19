import type { Airspace, AirspaceGeometry, AirspaceType } from '@flytrace/airspace';
import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

export interface AirspaceReadFilter {
  provider?: string | undefined;
  datasetVersion?: string | undefined;
}

export interface AirspaceBboxFilter extends AirspaceReadFilter {
  bbox: [west: number, south: number, east: number, north: number];
  types?: AirspaceType[] | undefined;
  limit?: number | undefined;
}

export interface AirspacePointFilter extends AirspaceReadFilter {
  lat: number;
  lon: number;
  altFt?: number | null | undefined;
  limit?: number | undefined;
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

function toAirspace(row: AirspaceRow): Airspace {
  return {
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
  };
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

      return rows.map(toAirspace);
    },

    async listActiveInBbox(filter: AirspaceBboxFilter): Promise<Airspace[]> {
      const [west, south, east, north] = filter.bbox;
      const clauses = [
        sql`effective_to is null`,
        sql`geojson is not null`,
        sql`geom is not null`,
        sql`geom && ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)`,
        sql`ST_Intersects(geom, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326))`,
      ];
      if (filter.provider) clauses.push(sql`provider = ${filter.provider}`);
      if (filter.datasetVersion) clauses.push(sql`dataset_version = ${filter.datasetVersion}`);
      if (filter.types?.length) {
        clauses.push(
          sql`(${sql.join(
            filter.types.map((type) => sql`type = ${type}`),
            sql` or `,
          )})`,
        );
      }

      const rows = (await db.execute(sql`
        select id, name, type, icao_class as "icaoClass", lower_ft as "lowerFt",
               upper_ft as "upperFt", frequency, geojson,
               provider, source_id as "sourceId", dataset_version as "datasetVersion"
        from geofences
        where ${sql.join(clauses, sql` and `)}
        order by
          case type
            when 'CTR' then 1
            when 'TMA' then 2
            when 'CTA' then 3
            when 'RESTRICTED' then 4
            when 'DANGER' then 5
            when 'PROHIBITED' then 6
            else 7
          end,
          name
        limit ${filter.limit ?? 500}
      `)) as unknown as AirspaceRow[];

      return rows.map(toAirspace);
    },

    async findContainingPoint(filter: AirspacePointFilter): Promise<Airspace[]> {
      const clauses = [
        sql`effective_to is null`,
        sql`geojson is not null`,
        sql`geom is not null`,
        sql`ST_Covers(geom, ST_SetSRID(ST_MakePoint(${filter.lon}, ${filter.lat}), 4326))`,
      ];
      if (filter.provider) clauses.push(sql`provider = ${filter.provider}`);
      if (filter.datasetVersion) clauses.push(sql`dataset_version = ${filter.datasetVersion}`);
      if (filter.altFt != null) {
        clauses.push(sql`(lower_ft is null or lower_ft <= ${filter.altFt})`);
        clauses.push(sql`(upper_ft is null or upper_ft >= ${filter.altFt})`);
      }

      const rows = (await db.execute(sql`
        select id, name, type, icao_class as "icaoClass", lower_ft as "lowerFt",
               upper_ft as "upperFt", frequency, geojson,
               provider, source_id as "sourceId", dataset_version as "datasetVersion"
        from geofences
        where ${sql.join(clauses, sql` and `)}
        order by
          case type
            when 'CTR' then 1
            when 'PROHIBITED' then 2
            when 'RESTRICTED' then 3
            when 'DANGER' then 4
            when 'TMA' then 5
            when 'CTA' then 6
            else 7
          end,
          name
        limit ${filter.limit ?? 50}
      `)) as unknown as AirspaceRow[];

      return rows.map(toAirspace);
    },
  };
}

export type AirspaceReadRepo = ReturnType<typeof createAirspaceReadRepo>;
