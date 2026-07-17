import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';

/**
 * Flight-domain read queries (docs/11 §11.6 public flight endpoints). Positions
 * are stored as PostGIS geography; lat/lon are projected out with ST_X/ST_Y on
 * the geometry cast. Kept separate from the write repo for clarity.
 */

export interface FlightRow {
  id: string;
  callsign: string;
  flightNumber: string | null;
  status: string;
  flightDate: string;
  source: string | null;
  lastSeenAt: string | null;
  createdAt: string;
}

export interface PositionRow {
  ts: string;
  lat: number | null;
  lon: number | null;
  altitudeFt: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
}

export interface EventRow {
  type: string;
  occurredAt: string;
  detectedAt: string;
  confidence: number;
  source: string;
  payload: unknown;
}

function createReadRepo(db: Database) {
  return {
    async getFlight(callsign: string, date: string): Promise<FlightRow | null> {
      const rows = (await db.execute(sql`
        select id, callsign, flight_number as "flightNumber", status,
               to_char(flight_date, 'YYYY-MM-DD') as "flightDate",
               source, last_seen_at as "lastSeenAt", created_at as "createdAt"
        from flights
        where callsign = ${callsign} and flight_date = ${date}
        order by created_at desc
        limit 1
      `)) as unknown as FlightRow[];
      return rows[0] ?? null;
    },

    async getLatestPosition(flightId: string): Promise<PositionRow | null> {
      const rows = (await db.execute(sql`
        select ts,
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon,
               altitude_ft as "altitudeFt", heading_deg as "headingDeg",
               ground_speed_kt as "groundSpeedKt", vertical_rate_fpm as "verticalRateFpm",
               on_ground as "onGround"
        from flight_positions
        where flight_id = ${flightId}
        order by ts desc
        limit 1
      `)) as unknown as PositionRow[];
      return rows[0] ?? null;
    },

    async getTrack(flightId: string, limit: number): Promise<PositionRow[]> {
      return (await db.execute(sql`
        select ts,
               ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon,
               altitude_ft as "altitudeFt", heading_deg as "headingDeg",
               ground_speed_kt as "groundSpeedKt", vertical_rate_fpm as "verticalRateFpm",
               on_ground as "onGround"
        from flight_positions
        where flight_id = ${flightId}
        order by ts asc
        limit ${limit}
      `)) as unknown as PositionRow[];
    },

    async getEvents(flightId: string): Promise<EventRow[]> {
      return (await db.execute(sql`
        select type, occurred_at as "occurredAt", detected_at as "detectedAt",
               confidence, source, payload
        from flight_events
        where flight_id = ${flightId}
        order by occurred_at asc
      `)) as unknown as EventRow[];
    },

    async countEventsToday(): Promise<number> {
      const rows = (await db.execute(sql`
        select count(*)::int as n from flight_events
        where detected_at >= date_trunc('day', now())
      `)) as unknown as { n: number }[];
      return rows[0]?.n ?? 0;
    },
  };
}

export { createReadRepo as createFlightReadRepo };
export type FlightReadRepo = ReturnType<typeof createReadRepo>;
