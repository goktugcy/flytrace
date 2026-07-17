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
 * THYProvider (docs/08 §8.10) — Turkish Airlines public flight status by
 * flight-number + date. Skeleton: the raw shape + status vocabulary reflect a
 * plausible public JSON response; the live base URL is supplied via `config`
 * (compliance/legal basis recorded there) and the provider ships **disabled**.
 */

const thyRawSchema = z.object({
  flightNo: z.string(),
  origin: z.string(),
  destination: z.string(),
  status: z.string(),
  gate: z.string().nullish(),
  terminal: z.string().nullish(),
  scheduledDeparture: z.string().nullish(),
  estimatedDeparture: z.string().nullish(),
  actualDeparture: z.string().nullish(),
  scheduledArrival: z.string().nullish(),
  estimatedArrival: z.string().nullish(),
  actualArrival: z.string().nullish(),
  aircraftType: z.string().nullish(),
  tail: z.string().nullish(),
});
export type ThyRaw = z.infer<typeof thyRawSchema>;

/** THY status vocabulary → canonical enum. */
const THY_VOCAB: Record<string, CanonicalStatus> = {
  scheduled: 'scheduled',
  departed: 'active',
  'en route': 'active',
  landed: 'landed',
  arrived: 'landed',
  delayed: 'delayed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  diverted: 'diverted',
};

/** Pure raw → normalized mapping (golden-tested independently of HTTP). */
export function normalizeThy(raw: ThyRaw, fetchedAt: string): NormalizedFlightStatus {
  return buildNormalized({
    flightNumber: raw.flightNo,
    airlineIata: 'TK',
    origin: raw.origin,
    destination: raw.destination,
    status: mapStatus(THY_VOCAB, raw.status),
    gate: raw.gate,
    terminal: raw.terminal,
    scheduledDeparture: raw.scheduledDeparture,
    estimatedDeparture: raw.estimatedDeparture,
    actualDeparture: raw.actualDeparture,
    scheduledArrival: raw.scheduledArrival,
    estimatedArrival: raw.estimatedArrival,
    actualArrival: raw.actualArrival,
    aircraftType: raw.aircraftType,
    registration: raw.tail,
    source: 'thy',
    fetchedAt,
    confidence: 0.85,
  });
}

export class THYProvider extends BaseProvider {
  readonly key = 'thy';
  readonly airlineIata = ['TK'];
  readonly capabilities: ProviderCapabilities = {
    status: true,
    gate: true,
    baggage: false,
    schedule: true,
  };
  protected readonly cacheTtlMs = 60_000;

  protected async fetchRaw(q: FlightStatusQuery): Promise<unknown> {
    if (q.by !== 'flightNumber') return null; // THY status is keyed by flight number
    const base = providerStatusUrl(this.ctx.config, this.key);
    const url = `${base}?flightNumber=${encodeURIComponent(q.flightNumber)}&date=${q.date}`;
    const raw = await this.ctx.http.getJson(url, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return thyRawSchema.parse(raw);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    if (!raw) return null;
    return normalizeThy(raw as ThyRaw, this.ctx.clock.nowIso());
  }
}

export function thyProviderFactory(): ProviderFactory {
  return { key: 'thy', airlineIata: ['TK'], create: () => new THYProvider() };
}
