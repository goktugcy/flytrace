import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { flightStatusSnapshot } from '../schema/flights.ts';

/**
 * Latest normalized provider status per flight (docs/05 flight_status_snapshots,
 * docs/08 §8). The worker's provider-fetch upserts here; the diff vs the prior
 * snapshot drives ProviderUpdated + derived gate/delay/cancelled events.
 */
export interface SnapshotStatus {
  status: string;
  gate: string | null;
  terminal: string | null;
  baggageBelt: string | null;
  scheduledDeparture: string | null;
  estimatedDeparture: string | null;
  actualDeparture: string | null;
  scheduledArrival: string | null;
  estimatedArrival: string | null;
  actualArrival: string | null;
}

export interface SnapshotUpsert extends Partial<SnapshotStatus> {
  flightId: string;
  providerKey: string;
  status: string;
  raw?: unknown;
  fetchedAt: Date;
}

const toDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

export function createFlightStatusRepo(db: Database) {
  return {
    async getSnapshot(flightId: string): Promise<SnapshotStatus | null> {
      const rows = (await db.execute(sql`
        select status, gate, terminal, baggage_belt as "baggageBelt",
               scheduled_departure as "scheduledDeparture", estimated_departure as "estimatedDeparture",
               actual_departure as "actualDeparture", scheduled_arrival as "scheduledArrival",
               estimated_arrival as "estimatedArrival", actual_arrival as "actualArrival"
        from flight_status_snapshots where flight_id = ${flightId} limit 1
      `)) as unknown as SnapshotStatus[];
      return rows[0] ?? null;
    },

    async upsertSnapshot(input: SnapshotUpsert): Promise<void> {
      const values = {
        flightId: input.flightId,
        providerKey: input.providerKey,
        status: input.status as (typeof flightStatusSnapshot.status.enumValues)[number],
        gate: input.gate ?? null,
        terminal: input.terminal ?? null,
        baggageBelt: input.baggageBelt ?? null,
        scheduledDeparture: toDate(input.scheduledDeparture),
        estimatedDeparture: toDate(input.estimatedDeparture),
        actualDeparture: toDate(input.actualDeparture),
        scheduledArrival: toDate(input.scheduledArrival),
        estimatedArrival: toDate(input.estimatedArrival),
        actualArrival: toDate(input.actualArrival),
        raw: input.raw ?? null,
        fetchedAt: input.fetchedAt,
      };
      await db
        .insert(flightStatusSnapshot)
        .values(values)
        .onConflictDoUpdate({ target: flightStatusSnapshot.flightId, set: values });
    },
  };
}

export type FlightStatusRepo = ReturnType<typeof createFlightStatusRepo>;
