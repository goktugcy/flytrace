import type { CatalogRepo } from '@flytrace/db';
import type { EventEnvelope, Logger } from '@flytrace/shared';

/** Minimal queue surface the scheduler needs (BullMQ Queue satisfies it). */
export interface EnqueueQueue {
  add(name: string, data: unknown, opts?: { jobId?: string }): Promise<unknown>;
}

/**
 * Parse an ICAO callsign into its airline designator + flight number digits.
 * e.g. "THY1TG" → { icao: "THY", number: "1" }. Returns null if it doesn't match.
 */
export function parseCallsign(callsign: string): { icao: string; number: string } | null {
  const m = callsign
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{3})(\d+)/);
  return m ? { icao: m[1] as string, number: m[2] as string } : null;
}

export interface ProviderSchedulerDeps {
  queue: EnqueueQueue;
  catalog: CatalogRepo;
  logger: Logger;
}

/**
 * Enqueues provider-fetch jobs for newly-detected flights whose airline has a
 * provider (docs/08 §8.8). Resolves the airline via the ICAO callsign prefix →
 * airlines table → IATA, derives the flight number, and enqueues one job keyed
 * by flightId (idempotent). Flights of unknown airlines stay position-only.
 */
export class ProviderScheduler {
  constructor(private readonly deps: ProviderSchedulerDeps) {}

  async onEvent(env: EventEnvelope): Promise<void> {
    if (env.type !== 'FlightDetected') return;
    const p = env.payload as {
      flightId: string;
      callsign: string | null;
      firstPosition: { ts: string };
    };
    if (!p.callsign) return;

    const parsed = parseCallsign(p.callsign);
    if (!parsed) return;

    const airline = await this.deps.catalog.getAirlineByIcao(parsed.icao);
    if (!airline?.iata) return; // unknown airline → no provider fetch

    const flightNumber = `${airline.iata}${parsed.number}`;
    const date = p.firstPosition.ts.slice(0, 10);
    await this.deps.queue.add(
      'fetch',
      { flightId: p.flightId, airlineIata: airline.iata, flightNumber, date },
      { jobId: `pf-${p.flightId}` }, // one fetch per flight leg (BullMQ jobId: no ':')
    );
    this.deps.logger.debug('scheduled provider fetch', { flightId: p.flightId, flightNumber });
  }
}
