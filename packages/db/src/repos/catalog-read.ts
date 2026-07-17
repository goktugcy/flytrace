import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

/**
 * Catalog read queries (docs/11 §11.6) backing the public airport & aircraft
 * pages. Airport locations are stored as PostGIS geography; lat/lon are
 * projected out with ST_X/ST_Y on the geometry cast, like flight positions.
 */

export interface AirportDetail {
  id: string;
  iata: string | null;
  icao: string;
  name: string;
  city: string | null;
  country: string | null;
  timezone: string | null;
  elevationFt: number | null;
  lat: number | null;
  lon: number | null;
}

export interface AircraftDetail {
  id: string;
  icao24: string;
  registration: string | null;
  typeIcao: string | null;
  typeName: string | null;
  manufacturer: string | null;
  builtYear: number | null;
  seats: number | null;
  airlineName: string | null;
  airlineIata: string | null;
}

/** A flight as seen from an airport or aircraft page (compact list row). */
export interface CatalogFlightRow {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  flightDate: string;
  role?: 'departure' | 'arrival';
}

function createCatalogReadRepo(db: Database) {
  return {
    async getAirportByIata(iata: string): Promise<AirportDetail | null> {
      const rows = (await db.execute(sql`
        select id, iata, icao, name, city, country, timezone,
               elevation_ft as "elevationFt",
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon
        from airports where iata = ${iata.toUpperCase()} limit 1
      `)) as unknown as AirportDetail[];
      return rows[0] ?? null;
    },

    /** Recent flights touching this airport, tagged as departure/arrival. */
    async getAirportFlights(airportId: string, limit: number): Promise<CatalogFlightRow[]> {
      return (await db.execute(sql`
        select id as "flightId", callsign, flight_number as "flightNumber", status,
               to_char(flight_date, 'YYYY-MM-DD') as "flightDate",
               case when origin_airport_id = ${airportId} then 'departure' else 'arrival' end as role
        from flights
        where origin_airport_id = ${airportId} or destination_airport_id = ${airportId}
        order by last_seen_at desc nulls last
        limit ${limit}
      `)) as unknown as CatalogFlightRow[];
    },

    async getAircraftByRegistration(registration: string): Promise<AircraftDetail | null> {
      const rows = (await db.execute(sql`
        select ac.id, ac.icao24, ac.registration, ac.type_icao as "typeIcao",
               ac.type_name as "typeName", ac.manufacturer, ac.built_year as "builtYear",
               ac.seats, al.name as "airlineName", al.iata as "airlineIata"
        from aircraft ac
        left join airlines al on al.id = ac.airline_id
        where ac.registration = ${registration.toUpperCase()} limit 1
      `)) as unknown as AircraftDetail[];
      return rows[0] ?? null;
    },

    async getAircraftFlights(aircraftId: string, limit: number): Promise<CatalogFlightRow[]> {
      return (await db.execute(sql`
        select id as "flightId", callsign, flight_number as "flightNumber", status,
               to_char(flight_date, 'YYYY-MM-DD') as "flightDate"
        from flights
        where aircraft_id = ${aircraftId}
        order by last_seen_at desc nulls last
        limit ${limit}
      `)) as unknown as CatalogFlightRow[];
    },
  };
}

export { createCatalogReadRepo };
export type CatalogReadRepo = ReturnType<typeof createCatalogReadRepo>;
