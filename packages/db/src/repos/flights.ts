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
  geoAltitudeFt?: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  squawk?: string | null;
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

/**
 * Enrichment patch applied to a flight once a provider resolves its schedule/
 * route/identity. Every field is optional; only provided keys are written, and
 * an already-set FK/value is never clobbered with null (COALESCE in SQL).
 */
export interface FlightEnrichment {
  flightNumber?: string;
  airlineId?: string;
  aircraftId?: string;
  originAirportId?: string;
  destinationAirportId?: string;
  scheduledDeparture?: Date;
  estimatedDeparture?: Date;
  actualDeparture?: Date;
  scheduledArrival?: Date;
  estimatedArrival?: Date;
  actualArrival?: Date;
}

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
        geoAltitudeFt: r.geoAltitudeFt ?? null,
        headingDeg: r.headingDeg,
        groundSpeedKt: r.groundSpeedKt,
        verticalRateFpm: r.verticalRateFpm,
        onGround: r.onGround,
        squawk: r.squawk ?? null,
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

    /**
     * Attach resolved identity/route/schedule to a flight (docs/08 §8.8). Only
     * the keys present in `patch` are written; unresolved fields are left as-is,
     * so a later fetch can fill gaps without erasing earlier enrichment.
     */
    async enrichFlight(flightId: string, patch: FlightEnrichment): Promise<void> {
      const set: Record<string, unknown> = {};
      if (patch.flightNumber !== undefined) set.flightNumber = patch.flightNumber;
      if (patch.airlineId !== undefined) set.airlineId = patch.airlineId;
      if (patch.aircraftId !== undefined) set.aircraftId = patch.aircraftId;
      if (patch.originAirportId !== undefined) set.originAirportId = patch.originAirportId;
      if (patch.destinationAirportId !== undefined)
        set.destinationAirportId = patch.destinationAirportId;
      if (patch.scheduledDeparture !== undefined) set.scheduledDeparture = patch.scheduledDeparture;
      if (patch.estimatedDeparture !== undefined) set.estimatedDeparture = patch.estimatedDeparture;
      if (patch.actualDeparture !== undefined) set.actualDeparture = patch.actualDeparture;
      if (patch.scheduledArrival !== undefined) set.scheduledArrival = patch.scheduledArrival;
      if (patch.estimatedArrival !== undefined) set.estimatedArrival = patch.estimatedArrival;
      if (patch.actualArrival !== undefined) set.actualArrival = patch.actualArrival;
      if (Object.keys(set).length === 0) return;
      set.updatedAt = new Date();
      await db.update(flights).set(set).where(sql`${flights.id} = ${flightId}`);
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
