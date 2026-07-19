import { customType, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Airspace geofences backing the EnteredAirspace feature (docs/07). A geofence
 * is a named controlled-airspace volume (FIR / TMA / CTA / CTR) with a vertical
 * band and a horizontal polygon. The tracker matches flight positions against
 * these to raise `entered_airspace` events; the API `/airspace/current` reads
 * them for the "what airspace am I in?" lookup.
 *
 * NEW file — not yet wired into schema/index.ts (see integration manifest).
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
    /** 'FIR' | 'TMA' | 'CTA' | 'CTR' (kept as text to stay provider-agnostic). */
    type: text('type').notNull(),
    icaoClass: text('icao_class'),
    lowerFt: integer('lower_ft'),
    upperFt: integer('upper_ft'),
    frequency: text('frequency'),
    /** PostGIS footprint for spatial queries (ST_Contains, GiST index). */
    geom: geometryPolygon('geom', { srid: 4326 }),
    /** Raw GeoJSON polygon for the app read path (no PostGIS round-trip). */
    geojson: jsonb('geojson'),
    /** Provenance: 'mock' | 'openaip' | 'openflightmaps' | 'aixm'. */
    source: text('source'),
  },
  (t) => [
    index('idx_geofences_geom').using('gist', t.geom),
    index('idx_geofences_type').on(t.type),
  ],
);
