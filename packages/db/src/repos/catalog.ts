import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

/** Catalog reads (airlines/airports/aircraft) used for enrichment + resolution. */
export interface AirlineRow {
  id: string;
  iata: string | null;
  icao: string | null;
  name: string;
  providerKey: string | null;
}

export function createCatalogRepo(db: Database) {
  return {
    /** Resolve an ICAO airline designator (callsign prefix) → airline row. */
    async getAirlineByIcao(icao: string): Promise<AirlineRow | null> {
      const rows = (await db.execute(sql`
        select id, iata, icao, name, provider_key as "providerKey"
        from airlines where icao = ${icao.toUpperCase()} limit 1
      `)) as unknown as AirlineRow[];
      return rows[0] ?? null;
    },
  };
}

export type CatalogRepo = ReturnType<typeof createCatalogRepo>;
