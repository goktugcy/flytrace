import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

/** One ground-movement transition, as projected from AirportStateChanged. */
export interface AirportGroundEventInput {
  flightId: string;
  icao24: string | null;
  airportId: string;
  state: string;
  previousState: string | null;
  gateRef: string | null;
  runwayRef: string | null;
  lat: number;
  lon: number;
  occurredAt: string;
  dedupeKey: string;
}

export interface AirportGroundEventRow {
  flightId: string;
  icao24: string | null;
  state: string;
  previousState: string | null;
  gateRef: string | null;
  runwayRef: string | null;
  lat: number | null;
  lon: number | null;
  occurredAt: string;
}

function createAirportGroundEventRepo(db: Database) {
  return {
    /** Idempotent insert (safe under at-least-once stream delivery). */
    async insert(e: AirportGroundEventInput): Promise<void> {
      await db.execute(sql`
        insert into airport_ground_events
          (flight_id, icao24, airport_id, state, previous_state, gate_ref, runway_ref, lat, lon, occurred_at, dedupe_key)
        values
          (${e.flightId}, ${e.icao24}, ${e.airportId}, ${e.state}, ${e.previousState},
           ${e.gateRef}, ${e.runwayRef}, ${e.lat}, ${e.lon}, ${e.occurredAt}, ${e.dedupeKey})
        on conflict (dedupe_key) do nothing`);
    },

    /** Chronological ground timeline for one flight. */
    async timelineForFlight(flightId: string, limit = 200): Promise<AirportGroundEventRow[]> {
      return (await db.execute(sql`
        select flight_id as "flightId", icao24, state, previous_state as "previousState",
               gate_ref as "gateRef", runway_ref as "runwayRef", lat, lon,
               occurred_at as "occurredAt"
        from airport_ground_events
        where flight_id = ${flightId}
        order by occurred_at asc
        limit ${limit}
      `)) as unknown as AirportGroundEventRow[];
    },

    /** Most recent transitions at an airport (operations feed). */
    async recentForAirport(airportId: string, limit = 100): Promise<AirportGroundEventRow[]> {
      return (await db.execute(sql`
        select flight_id as "flightId", icao24, state, previous_state as "previousState",
               gate_ref as "gateRef", runway_ref as "runwayRef", lat, lon,
               occurred_at as "occurredAt"
        from airport_ground_events
        where airport_id = ${airportId}
        order by occurred_at desc
        limit ${limit}
      `)) as unknown as AirportGroundEventRow[];
    },

    /** Latest state per aircraft at an airport (current ground picture). */
    async currentByAirport(
      airportId: string,
      sinceMs = 3_600_000,
    ): Promise<AirportGroundEventRow[]> {
      return (await db.execute(sql`
        select distinct on (flight_id)
               flight_id as "flightId", icao24, state, previous_state as "previousState",
               gate_ref as "gateRef", runway_ref as "runwayRef", lat, lon,
               occurred_at as "occurredAt"
        from airport_ground_events
        where airport_id = ${airportId}
          and occurred_at >= now() - (${sinceMs} || ' milliseconds')::interval
        order by flight_id, occurred_at desc
      `)) as unknown as AirportGroundEventRow[];
    },
  };
}

export { createAirportGroundEventRepo };
export type AirportGroundEventRepo = ReturnType<typeof createAirportGroundEventRepo>;
