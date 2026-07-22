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
  type: string | null;
  city: string | null;
  country: string | null;
  timezone: string | null;
  elevationFt: number | null;
  lat: number | null;
  lon: number | null;
  runways: unknown;
  scheduledService: boolean;
  homeUrl: string | null;
  wikipediaUrl: string | null;
  keywords: string | null;
}

export interface AirportMapRow {
  id: string;
  iata: string | null;
  icao: string;
  name: string;
  type: string | null;
  city: string | null;
  country: string | null;
  elevationFt: number | null;
  lat: number;
  lon: number;
  runwayCount: number;
  scheduledService: boolean;
  homeUrl: string | null;
  wikipediaUrl: string | null;
}

/** A row on an airport's departures/arrivals board. */
export interface BoardRow {
  flightId: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  counterpartIata: string | null;
  counterpartCity: string | null;
  scheduled: string | null;
  estimated: string | null;
  gate: string | null;
  terminal: string | null;
}

export interface AirportStats {
  departures: number;
  arrivals: number;
  active: number;
}

export interface AircraftStats {
  totalFlights: number;
  activeFlights: number;
  distinctRoutes: number;
  lastSeenAt: string | null;
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
        select id, iata, icao, name, type, city, country, timezone,
               elevation_ft as "elevationFt", runways,
               scheduled_service as "scheduledService",
               home_url as "homeUrl", wikipedia_url as "wikipediaUrl", keywords,
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon
        from airports where iata = ${iata.toUpperCase()} limit 1
      `)) as unknown as AirportDetail[];
      return rows[0] ?? null;
    },

    /** Resolve either an IATA or ICAO code returned by an operations provider. */
    async getAirportByCode(code: string): Promise<AirportDetail | null> {
      const normalized = code.trim().toUpperCase();
      const rows = (await db.execute(sql`
        select id, iata, icao, name, type, city, country, timezone,
               elevation_ft as "elevationFt", runways,
               scheduled_service as "scheduledService",
               home_url as "homeUrl", wikipedia_url as "wikipediaUrl", keywords,
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon
        from airports
        where iata = ${normalized} or icao = ${normalized}
        order by case when iata = ${normalized} then 0 else 1 end
        limit 1
      `)) as unknown as AirportDetail[];
      return rows[0] ?? null;
    },

    async getAirportById(id: string): Promise<AirportDetail | null> {
      const rows = (await db.execute(sql`
        select id, iata, icao, name, type, city, country, timezone,
               elevation_ft as "elevationFt", runways,
               scheduled_service as "scheduledService",
               home_url as "homeUrl", wikipedia_url as "wikipediaUrl", keywords,
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon
        from airports where id = ${id} limit 1
      `)) as unknown as AirportDetail[];
      return rows[0] ?? null;
    },

    async getAirportsInViewport(
      bbox: readonly [west: number, south: number, east: number, north: number],
      opts: { types?: string[]; includeClosed?: boolean; limit?: number } = {},
    ): Promise<AirportMapRow[]> {
      const [west, south, east, north] = bbox;
      const lonFilter =
        west <= east
          ? sql`lon between ${west} and ${east}`
          : sql`(lon >= ${west} or lon <= ${east})`;
      const typeFilter =
        opts.types && opts.types.length > 0
          ? sql`and type in (${sql.join(
              opts.types.map((t) => sql`${t}`),
              sql`, `,
            )})`
          : sql``;
      const closedFilter = opts.includeClosed ? sql`` : sql`and coalesce(type, '') <> 'closed'`;
      const limit = Math.max(1, Math.min(opts.limit ?? 1200, 2500));
      return (await db.execute(sql`
        with placed as (
          select id, iata, icao, name, type, city, country,
                 elevation_ft as "elevationFt",
                 scheduled_service as "scheduledService",
                 home_url as "homeUrl", wikipedia_url as "wikipediaUrl",
                 case
                   when jsonb_typeof(runways) = 'array' then jsonb_array_length(runways)
                   else 0
                 end as "runwayCount",
                 ST_Y(location::geometry) as lat,
                 ST_X(location::geometry) as lon
          from airports
          where location is not null
        )
        select *
        from placed
        where lat between ${south} and ${north}
          and ${lonFilter}
          ${closedFilter}
          ${typeFilter}
        order by
          case type
            when 'large_airport' then 1
            when 'medium_airport' then 2
            when 'small_airport' then 3
            when 'heliport' then 4
            when 'seaplane_base' then 5
            when 'balloonport' then 6
            else 7
          end,
          "scheduledService" desc,
          "runwayCount" desc,
          name asc
        limit ${limit}
      `)) as unknown as AirportMapRow[];
    },

    /**
     * Departures/arrivals board for an airport: the counterpart endpoint, gate/
     * terminal (from the latest provider snapshot) and scheduled/estimated
     * times, ordered by scheduled time. `dir` selects departures (origin match)
     * or arrivals (destination match).
     */
    async getAirportBoard(
      airportId: string,
      dir: 'departure' | 'arrival',
      limit: number,
    ): Promise<BoardRow[]> {
      const isDep = dir === 'departure';
      const matchCol = isDep ? sql`origin_airport_id` : sql`destination_airport_id`;
      const otherCol = isDep ? sql`destination_airport_id` : sql`origin_airport_id`;
      const schedCol = isDep ? sql`f.scheduled_departure` : sql`f.scheduled_arrival`;
      const estCol = isDep ? sql`f.estimated_departure` : sql`f.estimated_arrival`;
      return (await db.execute(sql`
        select f.id as "flightId", f.callsign, f.flight_number as "flightNumber", f.status,
               other.iata as "counterpartIata", other.city as "counterpartCity",
               ${schedCol} as scheduled, ${estCol} as estimated,
               s.gate, s.terminal
        from flights f
        left join airports other on other.id = f.${otherCol}
        left join flight_status_snapshots s on s.flight_id = f.id
        where f.${matchCol} = ${airportId}
        order by ${schedCol} desc nulls last, f.last_seen_at desc nulls last
        limit ${limit}
      `)) as unknown as BoardRow[];
    },

    async getAirportStats(airportId: string): Promise<AirportStats> {
      const rows = (await db.execute(sql`
        select
          count(*) filter (where origin_airport_id = ${airportId})::int      as departures,
          count(*) filter (where destination_airport_id = ${airportId})::int as arrivals,
          count(*) filter (
            where (origin_airport_id = ${airportId} or destination_airport_id = ${airportId})
              and status = 'active'
          )::int as active
        from flights
        where origin_airport_id = ${airportId} or destination_airport_id = ${airportId}
      `)) as unknown as AirportStats[];
      return rows[0] ?? { departures: 0, arrivals: 0, active: 0 };
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

    /** Utilization stats for an aircraft page (total legs, active, distinct routes). */
    async getAircraftStats(aircraftId: string): Promise<AircraftStats> {
      const rows = (await db.execute(sql`
        select
          count(*)::int                                          as "totalFlights",
          count(*) filter (where status = 'active')::int         as "activeFlights",
          count(distinct (origin_airport_id, destination_airport_id))::int as "distinctRoutes",
          max(last_seen_at) as "lastSeenAt"
        from flights where aircraft_id = ${aircraftId}
      `)) as unknown as AircraftStats[];
      return rows[0] ?? { totalFlights: 0, activeFlights: 0, distinctRoutes: 0, lastSeenAt: null };
    },
  };
}

export { createCatalogReadRepo };
export type CatalogReadRepo = ReturnType<typeof createCatalogReadRepo>;
