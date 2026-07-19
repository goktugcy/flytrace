import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Airspace geofences backing the EnteredAirspace feature (docs/07). A geofence
 * is a named controlled-airspace volume (FIR / TMA / CTA / CTR / restricted /
 * danger / prohibited) with a vertical band and a horizontal polygon. The
 * tracker matches flight positions against these to raise `entered_airspace`
 * events; the API `/airspace/current` reads them for the "what airspace am I
 * in?" lookup.
 */

/**
 * PostGIS geometry (SRID 4326) holding an arbitrary geometry — here a Polygon /
 * MultiPolygon airspace footprint. Stored/read as EWKT in Phase 0, mirroring the
 * `geographyPoint` convention in `_custom.ts`. Kept local to this module so the
 * shared custom-types file needs no edit.
 */
const geometryPolygon = customType<{
  data: string;
  driverData: string;
  config: { srid: number };
}>({
  dataType(config) {
    return `geometry(Geometry,${config?.srid ?? 4326})`;
  },
});

export const geofences = pgTable(
  'geofences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** Airspace kind, kept as text to stay provider-agnostic. */
    type: text('type').notNull(),
    icaoClass: text('icao_class'),
    lowerFt: integer('lower_ft'),
    upperFt: integer('upper_ft'),
    frequency: text('frequency'),
    /** PostGIS footprint for spatial queries (ST_Contains, GiST index). */
    geom: geometryPolygon('geom', { srid: 4326 }),
    /** Raw GeoJSON polygon for the app read path (no PostGIS round-trip). */
    geojson: jsonb('geojson'),
    /** Legacy provenance alias retained for compatibility. */
    source: text('source'),
    /** Provider provenance: 'mock' | 'openaip' | 'openflightmaps' | 'aixm'. */
    provider: text('provider'),
    /** Provider-native stable id used for idempotent imports. */
    sourceId: text('source_id'),
    /** Dataset/version identifier (date, release id, checksum, etc.). */
    datasetVersion: text('dataset_version'),
    importedAt: timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
    effectiveFrom: timestamp('effective_from', { withTimezone: true }),
    effectiveTo: timestamp('effective_to', { withTimezone: true }),
  },
  (t) => [
    index('idx_geofences_geom').using('gist', t.geom),
    index('idx_geofences_type').on(t.type),
    index('idx_geofences_provider_dataset').on(t.provider, t.datasetVersion),
    uniqueIndex('uq_geofences_provider_dataset_source').on(
      t.provider,
      t.datasetVersion,
      t.sourceId,
    ),
  ],
);
