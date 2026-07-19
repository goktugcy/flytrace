import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

export interface DbAirspaceImportRow {
  provider: string;
  sourceId: string;
  datasetVersion: string;
  importedAt: Date;
  effectiveFrom: Date | null;
  effectiveTo: Date | null;
  name: string;
  type: string;
  icaoClass: string | null;
  lowerFt: number | null;
  upperFt: number | null;
  frequency: string | null;
  geojson: unknown;
}

export function createAirspaceImportRepo(db: Database) {
  return {
    async validateGeometry(geometry: unknown): Promise<{ valid: boolean; reason?: string }> {
      const geojson = JSON.stringify(geometry);
      try {
        const rows = (await db.execute(sql`
          select
            ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)) as valid,
            ST_IsValidReason(ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326)) as reason
        `)) as unknown as Array<{ valid: boolean; reason: string | null }>;
        const row = rows[0];
        return {
          valid: row?.valid === true,
          ...(row?.reason ? { reason: row.reason } : {}),
        };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async upsertBatch(rows: DbAirspaceImportRow[]): Promise<number> {
      if (rows.length === 0) return 0;
      const tuples = rows.map((r) => {
        const geojson = JSON.stringify(r.geojson);
        const importedAt = r.importedAt.toISOString();
        const effectiveFrom = r.effectiveFrom?.toISOString() ?? null;
        const effectiveTo = r.effectiveTo?.toISOString() ?? null;
        return sql`(
          ${r.name}, ${r.type}, ${r.icaoClass}, ${r.lowerFt}, ${r.upperFt}, ${r.frequency},
          ST_SetSRID(ST_GeomFromGeoJSON(${geojson}), 4326), ${geojson}::jsonb, ${r.provider},
          ${r.provider}, ${r.sourceId}, ${r.datasetVersion}, ${importedAt}::timestamptz,
          ${effectiveFrom}::timestamptz, ${effectiveTo}::timestamptz
        )`;
      });
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into geofences
            (name, type, icao_class, lower_ft, upper_ft, frequency, geom, geojson,
             source, provider, source_id, dataset_version, imported_at, effective_from, effective_to)
          values ${sql.join(tuples, sql`, `)}
          on conflict (provider, dataset_version, source_id) do update set
            name = excluded.name,
            type = excluded.type,
            icao_class = excluded.icao_class,
            lower_ft = excluded.lower_ft,
            upper_ft = excluded.upper_ft,
            frequency = excluded.frequency,
            geom = excluded.geom,
            geojson = excluded.geojson,
            source = excluded.source,
            imported_at = excluded.imported_at,
            effective_from = excluded.effective_from,
            effective_to = excluded.effective_to
        `);
      });
      return rows.length;
    },

    async retirePreviousVersions(
      provider: string,
      activeDatasetVersion: string,
      retiredAt: Date,
    ): Promise<number> {
      const rows = (await db.execute(sql`
        update geofences
        set effective_to = ${retiredAt.toISOString()}::timestamptz
        where provider = ${provider}
          and dataset_version is not null
          and dataset_version <> ${activeDatasetVersion}
          and effective_to is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      return rows.length;
    },

    async retireMissing(
      provider: string,
      datasetVersion: string,
      activeSourceIds: string[],
      retiredAt: Date,
    ): Promise<number> {
      if (activeSourceIds.length === 0) return 0;
      const active = activeSourceIds.map((id) => sql`${id}`);
      const rows = (await db.execute(sql`
        update geofences
        set effective_to = ${retiredAt.toISOString()}::timestamptz
        where provider = ${provider}
          and dataset_version = ${datasetVersion}
          and source_id not in (${sql.join(active, sql`, `)})
          and effective_to is null
        returning id
      `)) as unknown as Array<{ id: string }>;
      return rows.length;
    },
  };
}

export type AirspaceImportRepo = ReturnType<typeof createAirspaceImportRepo>;
