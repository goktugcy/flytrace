import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { ewktPoint } from '../schema/_custom.ts';
import { flightEvents, flightPositions, flights } from '../schema/flights.ts';

/**
 * Flight-domain persistence (docs/06 §6.1: cross-module writes go through a
 * packages/db repository scoped to the owning module). Consumed by apps/worker
 * to durably project tracker events into Postgres. All writes are idempotent
 * so at-least-once stream delivery can't create duplicates.
 */

export interface FlightUpsert {
  flightId: string;
  callsign: string;
  flightDate: string; // YYYY-MM-DD (UTC)
  source: string;
  lastSeenAt: Date;
}

export interface PositionInput {
  flightId: string;
  ts: Date;
  icao24: string | null;
  lon: number;
  lat: number;
  altitudeFt: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  source: string;
}

export interface EventInput {
  flightId: string;
  type: (typeof flightEvents.type.enumValues)[number];
  occurredAt: Date;
  confidence: number;
  source: string;
  payload: unknown;
  dedupeKey: string;
}

export type EndReason = 'landed' | 'arrived' | 'timeout' | 'diverted';

export function createFlightRepo(db: Database) {
  return {
    /** Create the flight-leg row on first sight; refresh liveness thereafter. */
    async upsertFlight(f: FlightUpsert): Promise<void> {
      await db
        .insert(flights)
        .values({
          id: f.flightId,
          callsign: f.callsign,
          status: 'active',
          flightDate: f.flightDate,
          source: f.source,
          lastSeenAt: f.lastSeenAt,
        })
        .onConflictDoUpdate({
          target: flights.id,
          set: { lastSeenAt: f.lastSeenAt, updatedAt: new Date() },
        });
    },

    /** Batch-insert positions; (flight_id, ts) conflicts are dropped. */
    async insertPositions(rows: PositionInput[]): Promise<number> {
      if (rows.length === 0) return 0;
      const values = rows.map((r) => ({
        flightId: r.flightId,
        ts: r.ts,
        icao24: r.icao24,
        location: sql`${ewktPoint(r.lon, r.lat)}::geography`,
        altitudeFt: r.altitudeFt,
        headingDeg: r.headingDeg,
        groundSpeedKt: r.groundSpeedKt,
        verticalRateFpm: r.verticalRateFpm,
        onGround: r.onGround,
        source: r.source,
      }));
      await db.insert(flightPositions).values(values).onConflictDoNothing();
      return rows.length;
    },

    /** Insert a derived event; duplicate dedupe keys are ignored. */
    async insertEvent(e: EventInput): Promise<void> {
      await db
        .insert(flightEvents)
        .values({
          flightId: e.flightId,
          type: e.type,
          occurredAt: e.occurredAt,
          confidence: e.confidence,
          source: e.source,
          payload: e.payload,
          dedupeKey: e.dedupeKey,
        })
        .onConflictDoNothing({ target: flightEvents.dedupeKey });
    },

    /** Finalize a leg when it lands / times out. */
    async endFlight(flightId: string, endedAt: Date, reason: EndReason): Promise<void> {
      const status = reason === 'diverted' ? 'diverted' : 'landed';
      await db
        .update(flights)
        .set({
          status,
          lastSeenAt: endedAt,
          updatedAt: new Date(),
          ...(reason === 'landed' || reason === 'arrived' ? { actualArrival: endedAt } : {}),
        })
        .where(sql`${flights.id} = ${flightId}`);
    },
  };
}

export type FlightRepo = ReturnType<typeof createFlightRepo>;
