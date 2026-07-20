import type {
  CatalogRepo,
  FlightEnrichment,
  FlightRepo,
  FlightStatusRepo,
  SnapshotStatus,
} from '@flytrace/db';
import type { NormalizedFlightStatus, ProviderRegistry } from '@flytrace/providers';
import {
  type AircraftChangedPayload,
  type Clock,
  type Logger,
  type ProviderStatusFields,
  type ProviderUpdatedPayload,
  makeEnvelope,
} from '@flytrace/shared';
import type { ProviderFetchJob } from '@flytrace/shared';

const DIFF_FIELDS: (keyof ProviderStatusFields)[] = [
  'status',
  'gate',
  'terminal',
  'baggageBelt',
  'scheduledDeparture',
  'estimatedDeparture',
  'actualDeparture',
  'scheduledArrival',
  'estimatedArrival',
  'actualArrival',
];

function toFields(s: NormalizedFlightStatus): ProviderStatusFields {
  return {
    status: s.status,
    gate: s.gate ?? null,
    terminal: s.terminal ?? null,
    baggageBelt: s.baggageBelt ?? null,
    scheduledDeparture: s.scheduledDeparture ?? null,
    estimatedDeparture: s.estimatedDeparture ?? null,
    actualDeparture: s.actualDeparture ?? null,
    scheduledArrival: s.scheduledArrival ?? null,
    estimatedArrival: s.estimatedArrival ?? null,
    actualArrival: s.actualArrival ?? null,
  };
}

/** Field names that differ between the previous snapshot and the new status. */
export function diffStatus(before: SnapshotStatus | null, after: ProviderStatusFields): string[] {
  const changed: string[] = [];
  for (const f of DIFF_FIELDS) {
    const b = (before?.[f as keyof SnapshotStatus] ?? null) as unknown;
    const a = (after[f] ?? null) as unknown;
    if (b !== a) changed.push(f);
  }
  return changed;
}

/** Audit record of one provider fetch (docs/08 §8.9). */
export interface ProviderLogEntry {
  providerKey: string;
  operation: string;
  request: unknown;
  latencyMs: number;
  success: boolean;
  error?: string | null;
}

export interface ProviderFetchDeps {
  registry: ProviderRegistry;
  statusRepo: FlightStatusRepo;
  catalog: CatalogRepo;
  flightRepo: Pick<FlightRepo, 'enrichFlight'>;
  emit: (env: ReturnType<typeof makeEnvelope>) => Promise<void>;
  clock: Clock;
  logger: Logger;
  /** Optional provider-traffic sink (provider_logs); best-effort, never blocks. */
  logProvider?: (entry: ProviderLogEntry) => Promise<void>;
  /** Position-derived status fallback when no provider result is available. */
  deriveStatus?: (flightId: string) => Promise<ProviderStatusFields['status'] | null>;
}

function optDate(iso: string | undefined): Date | undefined {
  return iso ? new Date(iso) : undefined;
}

/**
 * Provider-fetch job processor (docs/08 §8.8): resolve the airline's provider,
 * fetch normalized status, project it into flight_status_snapshots, and emit
 * ProviderUpdated with the diff vs the prior snapshot. Idempotent-friendly: the
 * snapshot upsert + downstream event dedupe key make reruns safe.
 */
export class ProviderFetchService {
  constructor(private readonly deps: ProviderFetchDeps) {}

  async process(job: ProviderFetchJob): Promise<void> {
    const provider = this.deps.registry.forAirline(job.airlineIata);

    if (provider) {
      const startedAt = this.deps.clock.now();
      const result = await provider.getFlightStatus({
        by: 'flightNumber',
        flightNumber: job.flightNumber,
        date: job.date,
        callsign: job.callsign ?? null,
        icao24: job.icao24 ?? null,
      });
      await this.log({
        providerKey: provider.key,
        operation: 'getFlightStatus',
        request: {
          flightNumber: job.flightNumber,
          date: job.date,
          callsign: job.callsign ?? null,
          icao24: job.icao24 ?? null,
        },
        latencyMs: this.deps.clock.now() - startedAt,
        success: result !== null,
        error: result === null ? 'no result (miss/rate-limit/circuit)' : null,
      });
      if (result) {
        await this.commit(job.flightId, provider.key, toFields(result.status), result.status);
        await this.enrich(job, result.status);
        return;
      }
    }

    // No provider serves the airline, or the provider is unavailable (rate
    // limit / circuit open / miss): fall back to a status derived from the
    // aircraft's own track so every tracked flight still gets a coarse status
    // (docs/08 §8.10, docs/17 §17.5).
    await this.deriveFallback(job.flightId);
  }

  /** Project a status into the snapshot + emit ProviderUpdated on any diff. */
  private async commit(
    flightId: string,
    providerKey: string,
    after: ProviderStatusFields,
    raw: unknown,
  ): Promise<void> {
    const before = await this.deps.statusRepo.getSnapshot(flightId);
    const changed = diffStatus(before, after);
    const fetchedAt = this.deps.clock.nowIso();
    await this.deps.statusRepo.upsertSnapshot({
      flightId,
      providerKey,
      status: after.status ?? 'unknown',
      gate: after.gate ?? null,
      terminal: after.terminal ?? null,
      baggageBelt: after.baggageBelt ?? null,
      scheduledDeparture: after.scheduledDeparture ?? null,
      estimatedDeparture: after.estimatedDeparture ?? null,
      actualDeparture: after.actualDeparture ?? null,
      scheduledArrival: after.scheduledArrival ?? null,
      estimatedArrival: after.estimatedArrival ?? null,
      actualArrival: after.actualArrival ?? null,
      raw,
      fetchedAt: new Date(fetchedAt),
    });
    if (changed.length === 0) return;
    const payload: ProviderUpdatedPayload = {
      flightId,
      providerKey,
      before: before ? toSnapshotFields(before) : null,
      after,
      changed,
      fetchedAt,
    };
    await this.deps.emit(
      makeEnvelope(
        {
          type: 'ProviderUpdated',
          occurredAt: fetchedAt,
          dedupeKey: `${flightId}:provider:${fetchedAt.slice(0, 16)}`,
          partitionKey: flightId,
          payload,
        },
        { producer: 'worker', clock: this.deps.clock },
      ),
    );
  }

  /** Derive a coarse status from the flight's latest position (outage fallback). */
  private async deriveFallback(flightId: string): Promise<void> {
    if (!this.deps.deriveStatus) return;
    const status = await this.deps.deriveStatus(flightId);
    if (!status) return;
    const after: ProviderStatusFields = {
      status,
      gate: null,
      terminal: null,
      baggageBelt: null,
      scheduledDeparture: null,
      estimatedDeparture: null,
      actualDeparture: null,
      scheduledArrival: null,
      estimatedArrival: null,
      actualArrival: null,
    };
    await this.commit(flightId, 'derived', after, { derived: true, status });
  }

  /** Best-effort provider-traffic log; a logging failure never fails the job. */
  private async log(entry: ProviderLogEntry): Promise<void> {
    if (!this.deps.logProvider) return;
    try {
      await this.deps.logProvider(entry);
    } catch (err) {
      this.deps.logger.warn('provider log write failed', { err: String(err) });
    }
  }

  /**
   * Resolve identity/route/schedule from the normalized status into catalog FKs
   * and attach them to the flight row (docs/08 §8.8). Best-effort: unresolved
   * codes (unknown airline/airport/tail) are simply left off the patch.
   */
  private async enrich(job: ProviderFetchJob, s: NormalizedFlightStatus): Promise<void> {
    const flightId = job.flightId;
    // Aircraft attached to the flight *before* this enrich — the "history" side
    // of an aircraft-swap comparison.
    const prevIcao24 = await this.deps.catalog.getFlightIcao24(flightId);

    const patch: FlightEnrichment = { flightNumber: s.flightNumber };

    const [airlineId, originId, destinationId, aircraftId] = await Promise.all([
      this.deps.catalog.getAirlineIdByIata(s.airlineIata),
      this.deps.catalog.getAirportIdByIata(s.origin),
      this.deps.catalog.getAirportIdByIata(s.destination),
      s.registration
        ? this.deps.catalog.getAircraftIdByRegistration(s.registration)
        : Promise.resolve(null),
    ]);

    if (airlineId) patch.airlineId = airlineId;
    if (originId) patch.originAirportId = originId;
    if (destinationId) patch.destinationAirportId = destinationId;
    if (aircraftId) patch.aircraftId = aircraftId;

    const sd = optDate(s.scheduledDeparture);
    const ed = optDate(s.estimatedDeparture);
    const ad = optDate(s.actualDeparture);
    const sa = optDate(s.scheduledArrival);
    const ea = optDate(s.estimatedArrival);
    const aa = optDate(s.actualArrival);
    if (sd) patch.scheduledDeparture = sd;
    if (ed) patch.estimatedDeparture = ed;
    if (ad) patch.actualDeparture = ad;
    if (sa) patch.scheduledArrival = sa;
    if (ea) patch.estimatedArrival = ea;
    if (aa) patch.actualArrival = aa;

    await this.deps.flightRepo.enrichFlight(flightId, patch);

    // AircraftChanged (docs/07 §): the provider reports a tail whose icao24
    // differs from the aircraft we had on this flight. Emit once per
    // flightNumber+date (dedupe key); only when both tails are known.
    const newIcao24 = s.registration
      ? await this.deps.catalog.getIcao24ByRegistration(s.registration)
      : null;
    if (prevIcao24 && newIcao24 && prevIcao24 !== newIcao24) {
      const flightNumber = s.flightNumber ?? job.flightNumber;
      const payload: AircraftChangedPayload = {
        flightId,
        flightNumber,
        previousIcao24: prevIcao24,
        newIcao24,
      };
      await this.deps.emit(
        makeEnvelope(
          {
            type: 'AircraftChanged',
            occurredAt: this.deps.clock.nowIso(),
            dedupeKey: `${flightNumber}:${job.date}:aircraftChange`,
            partitionKey: flightId,
            payload,
          },
          { producer: 'worker', clock: this.deps.clock },
        ),
      );
    }
  }
}

function toSnapshotFields(s: SnapshotStatus): ProviderStatusFields {
  return {
    status: s.status as ProviderStatusFields['status'],
    gate: s.gate,
    terminal: s.terminal,
    baggageBelt: s.baggageBelt,
    scheduledDeparture: s.scheduledDeparture,
    estimatedDeparture: s.estimatedDeparture,
    actualDeparture: s.actualDeparture,
    scheduledArrival: s.scheduledArrival,
    estimatedArrival: s.estimatedArrival,
    actualArrival: s.actualArrival,
  };
}
