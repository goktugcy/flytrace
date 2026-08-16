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

/** One aircraft that took off from, or landed at, this airport. */
export interface AirportMovementRow {
  flightId: string;
  icao24: string | null;
  callsign: string | null;
  runwayRef: string | null;
  gateRef: string | null;
  /** Where the aircraft was at the moment of the transition. */
  lat: number | null;
  lon: number | null;
  occurredAt: string;
}

/**
 * The transition that means "this aircraft left the ground here". LINE_UP and
 * TAKEOFF_ROLL are still on the runway and can be aborted, so the departure is
 * only real once the state reaches AIRBORNE from one of them.
 */
const DEPARTURE_SQL = sql`state = 'AIRBORNE' and previous_state in ('TAKEOFF_ROLL', 'LINE_UP')`;

/**
 * Touchdown. LANDING is the transition worth reporting: TAXI_IN and
 * ARRIVED_GATE follow it, and reporting all three would list one arrival three
 * times.
 */
const ARRIVAL_SQL = sql`state = 'LANDING'`;

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

    /**
     * Aircraft that took off from, or landed at, this airport within a window.
     *
     * `distinct on (flight_id)` because a flight can produce the same transition
     * more than once — a go-around lands, climbs and lands again — and the board
     * should show one row per aircraft, not one per attempt.
     *
     * The callsign comes from `flights`; ground events only carry icao24, and a
     * hex code is not what anyone recognises on a departures board.
     */
    async movementsForAirport(
      airportId: string,
      dir: 'departure' | 'arrival',
      opts: { sinceMs?: number; limit?: number } = {},
    ): Promise<AirportMovementRow[]> {
      const sinceMs = opts.sinceMs ?? 6 * 60 * 60 * 1000;
      const limit = Math.min(opts.limit ?? 20, 100);
      const match = dir === 'departure' ? DEPARTURE_SQL : ARRIVAL_SQL;
      // `distinct on` forces its own ORDER BY, so the dedupe happens in the
      // inner query and the board's chronological order is applied outside it.
      return (await db.execute(sql`
        select * from (
          select distinct on (e.flight_id)
                 e.flight_id as "flightId", e.icao24, f.callsign,
                 e.runway_ref as "runwayRef", e.gate_ref as "gateRef",
                 e.lat, e.lon, e.occurred_at as "occurredAt"
          from airport_ground_events e
          left join flights f on f.id = e.flight_id
          where e.airport_id = ${airportId}
            and ${match}
            and e.occurred_at >= now() - (${sinceMs} || ' milliseconds')::interval
          order by e.flight_id, e.occurred_at desc
        ) m
        order by m."occurredAt" desc
        limit ${limit}
      `)) as unknown as AirportMovementRow[];
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
