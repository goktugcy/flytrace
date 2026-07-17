import type { Clock, Logger } from '@flytrace/shared';
import { z } from 'zod';

/**
 * Provider contracts (docs/08 §8.4). A concrete provider implements only
 * fetchRaw + normalize; all cross-cutting behavior lives in BaseProvider.
 */

export const flightStatusValues = [
  'scheduled',
  'active',
  'landed',
  'delayed',
  'cancelled',
  'diverted',
  'unknown',
] as const;
export const flightStatusSchema = z.enum(flightStatusValues);

export const normalizedFlightStatusSchema = z.object({
  flightNumber: z.string(),
  airlineIata: z.string(),
  origin: z.string(), // IATA
  destination: z.string(), // IATA
  status: flightStatusSchema,
  scheduledDeparture: z.string().optional(),
  estimatedDeparture: z.string().optional(),
  actualDeparture: z.string().optional(),
  scheduledArrival: z.string().optional(),
  estimatedArrival: z.string().optional(),
  actualArrival: z.string().optional(),
  gate: z.string().optional(),
  terminal: z.string().optional(),
  baggageBelt: z.string().optional(),
  aircraftType: z.string().optional(),
  registration: z.string().optional(),
  source: z.string(),
  fetchedAt: z.string(),
  confidence: z.number().min(0).max(1),
});
export type NormalizedFlightStatus = z.infer<typeof normalizedFlightStatusSchema>;

export type FlightStatusQuery =
  | { by: 'flightNumber'; flightNumber: string; date: string }
  | { by: 'route'; from: string; to: string; date: string };

export interface ProviderCapabilities {
  status: boolean;
  gate: boolean;
  baggage: boolean;
  schedule: boolean;
}

export type ProviderHealth = 'up' | 'degraded' | 'down';

/** Minimal HTTP port injected into providers (never construct clients directly). */
export interface HttpClient {
  getJson(
    url: string,
    opts?: { headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<unknown>;
}

/** Read-through cache port (Redis-backed in prod, in-memory in tests). */
export interface ProviderCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

/** Distributed token-bucket rate limiter port. */
export interface RateLimiter {
  /** Try to take one token for `key`; false when the budget is exhausted. */
  tryAcquire(key: string): Promise<boolean>;
}

export interface ProviderContext {
  http: HttpClient;
  cache: ProviderCache;
  rateLimiter: RateLimiter;
  logger: Logger;
  clock: Clock;
  config: Record<string, unknown>;
}

export interface FlightStatusResult {
  status: NormalizedFlightStatus;
  cached: boolean;
}

export interface FlightProvider {
  readonly key: string;
  readonly airlineIata: string[];
  readonly capabilities: ProviderCapabilities;
  init(ctx: ProviderContext): Promise<void>;
  healthCheck(): Promise<ProviderHealth>;
  getFlightStatus(q: FlightStatusQuery): Promise<FlightStatusResult | null>;
}

/** Static registration unit (docs/08 §8.6). */
export interface ProviderFactory {
  key: string;
  airlineIata: string[];
  create(): FlightProvider;
}

export function cacheKey(providerKey: string, q: FlightStatusQuery): string {
  return q.by === 'flightNumber'
    ? `provider:cache:${providerKey}:fn:${q.flightNumber}:${q.date}`
    : `provider:cache:${providerKey}:rt:${q.from}-${q.to}:${q.date}`;
}
