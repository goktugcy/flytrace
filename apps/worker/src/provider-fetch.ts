import type {
  CatalogRepo,
  FlightEnrichment,
  FlightRepo,
  FlightStatusRepo,
  SnapshotStatus,
} from '@flytrace/db';
import type { NormalizedFlightStatus, ProviderRegistry } from '@flytrace/providers';
import {
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

export interface ProviderFetchDeps {
  registry: ProviderRegistry;
  statusRepo: FlightStatusRepo;
  catalog: CatalogRepo;
  flightRepo: Pick<FlightRepo, 'enrichFlight'>;
  emit: (env: ReturnType<typeof makeEnvelope>) => Promise<void>;
  clock: Clock;
  logger: Logger;
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
    if (!provider) {
      this.deps.logger.debug('no provider for airline', { airline: job.airlineIata });
      return;
    }

    const result = await provider.getFlightStatus({
      by: 'flightNumber',
      flightNumber: job.flightNumber,
      date: job.date,
    });
    if (!result) return;

    const after = toFields(result.status);
    const before = await this.deps.statusRepo.getSnapshot(job.flightId);
    const changed = diffStatus(before, after);

    const fetchedAt = this.deps.clock.nowIso();
    await this.deps.statusRepo.upsertSnapshot({
      flightId: job.flightId,
      providerKey: provider.key,
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
      raw: result.status,
      fetchedAt: new Date(fetchedAt),
    });

    await this.enrich(job.flightId, result.status);

    if (changed.length === 0) return; // nothing new → no event

    const payload: ProviderUpdatedPayload = {
      flightId: job.flightId,
      providerKey: provider.key,
      before: before ? toSnapshotFields(before) : null,
      after,
      changed,
      fetchedAt,
    };
    const bucket = fetchedAt.slice(0, 16); // minute bucket (dedupe)
    await this.deps.emit(
      makeEnvelope(
        {
          type: 'ProviderUpdated',
          occurredAt: fetchedAt,
          dedupeKey: `${job.flightId}:provider:${bucket}`,
          partitionKey: job.flightId,
          payload,
        },
        { producer: 'worker', clock: this.deps.clock },
      ),
    );
  }

  /**
   * Resolve identity/route/schedule from the normalized status into catalog FKs
   * and attach them to the flight row (docs/08 §8.8). Best-effort: unresolved
   * codes (unknown airline/airport/tail) are simply left off the patch.
   */
  private async enrich(flightId: string, s: NormalizedFlightStatus): Promise<void> {
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
