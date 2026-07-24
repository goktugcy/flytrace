import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

/**
 * Read airport ground geometry (from `airport_geometries`) as GeoJSON — used by
 * the airport ground-view API and preloaded into the ground state engine's RAM
 * spatial index.
 */
export interface AirportGeometryRow {
  id: string;
  kind: string;
  ref: string | null;
  name: string | null;
  /** Parsed GeoJSON geometry (Point / LineString / Polygon), or null. */
  geojson: unknown;
}

interface RawRow {
  id: string;
  kind: string;
  ref: string | null;
  name: string | null;
  geojson: string | null;
}

function mapRows(rows: RawRow[]): AirportGeometryRow[] {
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    ref: r.ref,
    name: r.name,
    geojson: r.geojson ? JSON.parse(r.geojson) : null,
  }));
}

function createAirportGroundReadRepo(db: Database) {
  return {
    async byAirportId(airportId: string): Promise<AirportGeometryRow[]> {
      const rows = (await db.execute(sql`
        select id, kind, ref, name, ST_AsGeoJSON(geom) as geojson
        from airport_geometries
        where airport_id = ${airportId}
        order by kind
      `)) as unknown as RawRow[];
      return mapRows(rows);
    },

    /** Airports that have imported ground geometry, with their centroid. */
    async listAirportsWithGeometry(): Promise<
      { airportId: string; icao: string; lat: number; lon: number }[]
    > {
      const rows = (await db.execute(sql`
        select distinct a.id as "airportId", a.icao,
               ST_Y(a.location::geometry) as lat, ST_X(a.location::geometry) as lon
        from airport_geometries g
        join airports a on a.id = g.airport_id
        where a.location is not null
      `)) as unknown as { airportId: string; icao: string; lat: number; lon: number }[];
      return rows;
    },

    async byIcao(icao: string): Promise<AirportGeometryRow[]> {
      const rows = (await db.execute(sql`
        select g.id, g.kind, g.ref, g.name, ST_AsGeoJSON(g.geom) as geojson
        from airport_geometries g
        join airports a on a.id = g.airport_id
        where a.icao = ${icao.toUpperCase()}
        order by g.kind
      `)) as unknown as RawRow[];
      return mapRows(rows);
    },
  };
}

export { createAirportGroundReadRepo };
export type AirportGroundReadRepo = ReturnType<typeof createAirportGroundReadRepo>;
