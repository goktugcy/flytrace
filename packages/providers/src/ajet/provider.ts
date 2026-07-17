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
 * AJetProvider (docs/08 §8.10) — AJet (IATA `VF`) public status. Skeleton with
 * an uppercase status vocabulary and a nested `times` object; live base URL via
 * `config`, ships **disabled** pending compliance clearance.
 */

const ajetRawSchema = z.object({
  flight: z.string(),
  dep: z.string(),
  arr: z.string(),
  flightStatus: z.string(),
  gateNumber: z.string().nullish(),
  terminalName: z.string().nullish(),
  times: z
    .object({
      schedOut: z.string().nullish(),
      estOut: z.string().nullish(),
      actOut: z.string().nullish(),
      schedIn: z.string().nullish(),
      estIn: z.string().nullish(),
      actIn: z.string().nullish(),
    })
    .nullish(),
  equipmentType: z.string().nullish(),
});
export type AjetRaw = z.infer<typeof ajetRawSchema>;

const AJET_VOCAB: Record<string, CanonicalStatus> = {
  scheduled: 'scheduled',
  active: 'active',
  departed: 'active',
  landed: 'landed',
  arrived: 'landed',
  delayed: 'delayed',
  cancelled: 'cancelled',
  diverted: 'diverted',
};

export function normalizeAjet(raw: AjetRaw, fetchedAt: string): NormalizedFlightStatus {
  const t = raw.times ?? {};
  return buildNormalized({
    flightNumber: raw.flight,
    airlineIata: 'VF',
    origin: raw.dep,
    destination: raw.arr,
    status: mapStatus(AJET_VOCAB, raw.flightStatus),
    gate: raw.gateNumber,
    terminal: raw.terminalName,
    scheduledDeparture: t.schedOut,
    estimatedDeparture: t.estOut,
    actualDeparture: t.actOut,
    scheduledArrival: t.schedIn,
    estimatedArrival: t.estIn,
    actualArrival: t.actIn,
    aircraftType: raw.equipmentType,
    source: 'ajet',
    fetchedAt,
    confidence: 0.8,
  });
}

export class AJetProvider extends BaseProvider {
  readonly key = 'ajet';
  readonly airlineIata = ['VF'];
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
    const url = `${base}/${encodeURIComponent(q.flightNumber)}/${q.date}`;
    const raw = await this.ctx.http.getJson(url, {
      headers: { 'user-agent': USER_AGENT },
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
    return ajetRawSchema.parse(raw);
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    if (!raw) return null;
    return normalizeAjet(raw as AjetRaw, this.ctx.clock.nowIso());
  }
}

export function ajetProviderFactory(): ProviderFactory {
  return { key: 'ajet', airlineIata: ['VF'], create: () => new AJetProvider() };
}
