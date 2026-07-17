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
 * PegasusProvider (docs/08 §8.10) — Pegasus Airlines (IATA `PC`) public status.
 * Skeleton with a plausible flatter JSON shape (three-letter time codes); live
 * base URL via `config`, ships **disabled** pending compliance clearance.
 */

const pegasusRawSchema = z.object({
  flightNumber: z.string(),
  from: z.string(),
  to: z.string(),
  state: z.string(),
  gate: z.string().nullish(),
  terminal: z.string().nullish(),
  std: z.string().nullish(), // scheduled time of departure
  etd: z.string().nullish(),
  atd: z.string().nullish(),
  sta: z.string().nullish(), // scheduled time of arrival
  eta: z.string().nullish(),
  ata: z.string().nullish(),
  equipment: z.string().nullish(),
});
export type PegasusRaw = z.infer<typeof pegasusRawSchema>;

const PEGASUS_VOCAB: Record<string, CanonicalStatus> = {
  'on-time': 'scheduled',
  scheduled: 'scheduled',
  boarding: 'scheduled',
  departed: 'active',
  airborne: 'active',
  arrived: 'landed',
  landed: 'landed',
  delayed: 'delayed',
  cancelled: 'cancelled',
  diverted: 'diverted',
};

export function normalizePegasus(raw: PegasusRaw, fetchedAt: string): NormalizedFlightStatus {
  return buildNormalized({
    flightNumber: raw.flightNumber,
    airlineIata: 'PC',
    origin: raw.from,
    destination: raw.to,
    status: mapStatus(PEGASUS_VOCAB, raw.state),
    gate: raw.gate,
    terminal: raw.terminal,
    scheduledDeparture: raw.std,
    estimatedDeparture: raw.etd,
    actualDeparture: raw.atd,
    scheduledArrival: raw.sta,
    estimatedArrival: raw.eta,
    actualArrival: raw.ata,
    aircraftType: raw.equipment,
    source: 'pegasus',
    fetchedAt,
    confidence: 0.8,
  });
}

export class PegasusProvider extends BaseProvider {
  readonly key = 'pegasus';
  readonly airlineIata = ['PC'];
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
    const url = `${base}?fn=${encodeURIComponent(q.flightNumber)}&d=${q.date}`;
    const raw = await this.ctx.http.getJson(url, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return pegasusRawSchema.parse(raw);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    if (!raw) return null;
    return normalizePegasus(raw as PegasusRaw, this.ctx.clock.nowIso());
  }
}

export function pegasusProviderFactory(): ProviderFactory {
  return { key: 'pegasus', airlineIata: ['PC'], create: () => new PegasusProvider() };
}
