import { z } from 'zod';
import { BaseProvider } from '../base-provider.ts';
import { DEFAULT_TIMEOUT_MS, USER_AGENT, providerStatusUrl } from '../common/http.ts';
import { type CanonicalStatus, buildNormalized, mapStatus } from '../common/normalize.ts';
import type {
  FlightStatusQuery,
  NormalizedFlightStatus,
  ProviderCapabilities,
  ProviderFactory,
} from '../types.ts';

/**
 * LufthansaProvider (docs/08 §8.10) — Lufthansa (IATA `LH`) public status.
 * Skeleton with a nested departure/arrival shape (official-API style); live
 * base URL via `config`, ships **disabled** pending compliance clearance.
 */

const legSchema = z
  .object({
    airport: z.string(),
    scheduled: z.string().nullish(),
    estimated: z.string().nullish(),
    actual: z.string().nullish(),
    terminal: z.string().nullish(),
    gate: z.string().nullish(),
  })
  .nullish();

const lhRawSchema = z.object({
  flightNumber: z.string(),
  status: z.string(),
  departure: legSchema,
  arrival: legSchema,
  aircraftType: z.string().nullish(),
});
export type LhRaw = z.infer<typeof lhRawSchema>;

const LH_VOCAB: Record<string, CanonicalStatus> = {
  scheduled: 'scheduled',
  ontime: 'scheduled',
  boarding: 'scheduled',
  departed: 'active',
  enroute: 'active',
  landed: 'landed',
  arrived: 'landed',
  delayed: 'delayed',
  cancelled: 'cancelled',
  diverted: 'diverted',
};

export function normalizeLufthansa(raw: LhRaw, fetchedAt: string): NormalizedFlightStatus {
  const dep = raw.departure;
  const arr = raw.arrival;
  return buildNormalized({
    flightNumber: raw.flightNumber,
    airlineIata: 'LH',
    origin: dep?.airport ?? '',
    destination: arr?.airport ?? '',
    status: mapStatus(LH_VOCAB, raw.status),
    gate: dep?.gate,
    terminal: dep?.terminal,
    scheduledDeparture: dep?.scheduled,
    estimatedDeparture: dep?.estimated,
    actualDeparture: dep?.actual,
    scheduledArrival: arr?.scheduled,
    estimatedArrival: arr?.estimated,
    actualArrival: arr?.actual,
    aircraftType: raw.aircraftType,
    source: 'lufthansa',
    fetchedAt,
    confidence: 0.85,
  });
}

export class LufthansaProvider extends BaseProvider {
  readonly key = 'lufthansa';
  readonly airlineIata = ['LH'];
  readonly capabilities: ProviderCapabilities = {
    status: true,
    gate: true,
    baggage: false,
    schedule: true,
  };
  protected readonly cacheTtlMs = 60_000;

  protected async fetchRaw(q: FlightStatusQuery): Promise<unknown> {
    if (q.by !== 'flightNumber') return null;
    const base = providerStatusUrl(this.ctx.config, this.key);
    const url = `${base}/${encodeURIComponent(q.flightNumber)}?date=${q.date}`;
    const raw = await this.ctx.http.getJson(url, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return lhRawSchema.parse(raw);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    if (!raw) return null;
    return normalizeLufthansa(raw as LhRaw, this.ctx.clock.nowIso());
  }
}

export function lufthansaProviderFactory(): ProviderFactory {
  return { key: 'lufthansa', airlineIata: ['LH'], create: () => new LufthansaProvider() };
}
