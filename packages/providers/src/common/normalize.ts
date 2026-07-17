import type { NormalizedFlightStatus } from '../types.ts';

export type CanonicalStatus = NormalizedFlightStatus['status'];

/**
 * Map a provider's own status vocabulary to the canonical enum via a lookup
 * table (docs/08 §8.10). Tokens are matched case-insensitively after trimming;
 * anything unmapped degrades to 'unknown' rather than guessing.
 */
export function mapStatus(
  vocab: Record<string, CanonicalStatus>,
  token: string | null | undefined,
): CanonicalStatus {
  if (!token) return 'unknown';
  return vocab[token.trim().toLowerCase()] ?? 'unknown';
}

/** Optional-field inputs for {@link buildNormalized} (null/undefined = absent). */
export interface NormalizedInput {
  flightNumber: string;
  airlineIata: string;
  origin: string;
  destination: string;
  status: CanonicalStatus;
  source: string;
  fetchedAt: string;
  confidence: number;
  gate?: string | null | undefined;
  terminal?: string | null | undefined;
  baggageBelt?: string | null | undefined;
  scheduledDeparture?: string | null | undefined;
  estimatedDeparture?: string | null | undefined;
  actualDeparture?: string | null | undefined;
  scheduledArrival?: string | null | undefined;
  estimatedArrival?: string | null | undefined;
  actualArrival?: string | null | undefined;
  aircraftType?: string | null | undefined;
  registration?: string | null | undefined;
}

const OPTIONAL_KEYS = [
  'gate',
  'terminal',
  'baggageBelt',
  'scheduledDeparture',
  'estimatedDeparture',
  'actualDeparture',
  'scheduledArrival',
  'estimatedArrival',
  'actualArrival',
  'aircraftType',
  'registration',
] as const;

/**
 * Assemble a NormalizedFlightStatus, omitting optional keys that are null/
 * undefined (satisfies exactOptionalPropertyTypes — never writes `key: undefined`).
 */
export function buildNormalized(i: NormalizedInput): NormalizedFlightStatus {
  const out: NormalizedFlightStatus = {
    flightNumber: i.flightNumber,
    airlineIata: i.airlineIata,
    origin: i.origin.toUpperCase(),
    destination: i.destination.toUpperCase(),
    status: i.status,
    source: i.source,
    fetchedAt: i.fetchedAt,
    confidence: i.confidence,
  };
  for (const k of OPTIONAL_KEYS) {
    const v = i[k];
    if (v != null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
