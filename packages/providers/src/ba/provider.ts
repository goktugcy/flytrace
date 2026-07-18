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
 * BritishAirwaysProvider (docs/08 §8.10) — British Airways (IATA `BA`) public
 * status. Skeleton with a flat shape; live base URL via `config`, ships
 * **disabled** pending compliance clearance.
 */

const baRawSchema = z.object({
  flight: z.string(),
  from: z.string(),
  to: z.string(),
  flightStatus: z.string(),
  depTerminal: z.string().nullish(),
  depGate: z.string().nullish(),
  schedDep: z.string().nullish(),
  estDep: z.string().nullish(),
  actDep: z.string().nullish(),
  schedArr: z.string().nullish(),
  estArr: z.string().nullish(),
  actArr: z.string().nullish(),
  aircraft: z.string().nullish(),
});
export type BaRaw = z.infer<typeof baRawSchema>;

const BA_VOCAB: Record<string, CanonicalStatus> = {
  scheduled: 'scheduled',
  'on time': 'scheduled',
  boarding: 'scheduled',
  departed: 'active',
  airborne: 'active',
  landed: 'landed',
  arrived: 'landed',
  delayed: 'delayed',
  cancelled: 'cancelled',
  diverted: 'diverted',
};

export function normalizeBa(raw: BaRaw, fetchedAt: string): NormalizedFlightStatus {
  return buildNormalized({
    flightNumber: raw.flight,
    airlineIata: 'BA',
    origin: raw.from,
    destination: raw.to,
    status: mapStatus(BA_VOCAB, raw.flightStatus),
    gate: raw.depGate,
    terminal: raw.depTerminal,
    scheduledDeparture: raw.schedDep,
    estimatedDeparture: raw.estDep,
    actualDeparture: raw.actDep,
    scheduledArrival: raw.schedArr,
    estimatedArrival: raw.estArr,
    actualArrival: raw.actArr,
    aircraftType: raw.aircraft,
    source: 'ba',
    fetchedAt,
    confidence: 0.85,
  });
}

export class BritishAirwaysProvider extends BaseProvider {
  readonly key = 'ba';
  readonly airlineIata = ['BA'];
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
    return baRawSchema.parse(raw);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    if (!raw) return null;
    return normalizeBa(raw as BaRaw, this.ctx.clock.nowIso());
  }
}

export function baProviderFactory(): ProviderFactory {
  return { key: 'ba', airlineIata: ['BA'], create: () => new BritishAirwaysProvider() };
}
