import { customType } from 'drizzle-orm/pg-core';

/**
 * PostGIS geography point (SRID 4326). Stored/read as EWKT string in Phase 0;
 * richer (lat/lon object) mapping can be layered on later without a migration.
 */
export const geographyPoint = customType<{
  data: string;
  driverData: string;
  config: { srid: number };
}>({
  dataType(config) {
    return `geography(Point,${config?.srid ?? 4326})`;
  },
});

/**
 * Generic PostGIS geometry (SRID 4326) for lines/polygons/points — airport
 * runways, taxiways, aprons, gates, etc. Read as GeoJSON/WKT via ST_* in
 * queries; written with ST_GeomFromEWKT. Kept separate from the geography
 * point type used for single locations.
 */
export const geometry = customType<{
  data: string;
  driverData: string;
  config: { srid: number };
}>({
  dataType(config) {
    return `geometry(Geometry,${config?.srid ?? 4326})`;
  },
});

/** Case-insensitive text (requires the `citext` extension). */
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

/** Helper to build an EWKT point literal from lon/lat. */
export function ewktPoint(lon: number, lat: number): string {
  return `SRID=4326;POINT(${lon} ${lat})`;
}
