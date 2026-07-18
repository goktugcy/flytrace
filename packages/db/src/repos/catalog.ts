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

    /** Resolve an IATA airline designator → airline id (enrichment). */
    async getAirlineIdByIata(iata: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        select id from airlines where iata = ${iata.toUpperCase()} limit 1
      `)) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    },

    /** Resolve an IATA airline designator → ICAO (callsign prefix); for search. */
    async getIcaoByIata(iata: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        select icao from airlines where iata = ${iata.toUpperCase()} limit 1
      `)) as unknown as { icao: string | null }[];
      return rows[0]?.icao ?? null;
    },

    /** Resolve an IATA airport code → airport id (origin/destination FKs). */
    async getAirportIdByIata(iata: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        select id from airports where iata = ${iata.toUpperCase()} limit 1
      `)) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    },

    /**
     * Resolve an aircraft by registration → aircraft id. Link-only (does not
     * insert): the aircraft table is keyed by icao24, which provider status
     * doesn't carry, so we only attach when the tail is already catalogued.
     */
    async getAircraftIdByRegistration(registration: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        select id from aircraft where registration = ${registration.toUpperCase()} limit 1
      `)) as unknown as { id: string }[];
      return rows[0]?.id ?? null;
    },
  };
}

export type CatalogRepo = ReturnType<typeof createCatalogRepo>;
