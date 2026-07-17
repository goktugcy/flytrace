import { type Clock, createLogger, fixedClock } from '@flytrace/shared';
import { BaseProvider } from '../base-provider.ts';
import type {
  FlightStatusQuery,
  HttpClient,
  NormalizedFlightStatus,
  ProviderCache,
  ProviderCapabilities,
  ProviderContext,
  RateLimiter,
} from '../types.ts';

/** In-memory cache with clock-driven TTL (deterministic in tests). */
export class InMemoryCache implements ProviderCache {
  private store = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly clock: Clock) {}
  async get(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return null;
    }
    return e.value;
  }
  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.clock.now() + ttlMs });
  }
}

export const allowRateLimiter: RateLimiter = { tryAcquire: async () => true };
export const denyRateLimiter: RateLimiter = { tryAcquire: async () => false };

const noopHttp: HttpClient = { getJson: async () => ({}) };

export function fakeProviderContext(overrides: Partial<ProviderContext> = {}): ProviderContext {
  const clock = overrides.clock ?? fixedClock(1_700_000_000_000);
  return {
    http: overrides.http ?? noopHttp,
    cache: overrides.cache ?? new InMemoryCache(clock),
    rateLimiter: overrides.rateLimiter ?? allowRateLimiter,
    logger: overrides.logger ?? createLogger({ level: 'error', base: {} }),
    clock,
    config: overrides.config ?? {},
  };
}

export function normalizedFixture(
  over: Partial<NormalizedFlightStatus> = {},
): NormalizedFlightStatus {
  return {
    flightNumber: 'TK1980',
    airlineIata: 'TK',
    origin: 'IST',
    destination: 'LHR',
    status: 'active',
    gate: 'A12',
    source: 'fake',
    fetchedAt: '2023-11-14T22:00:00.000Z',
    confidence: 0.9,
    ...over,
  };
}

/** Fixture-backed provider for tests (no network). Counts upstream fetches. */
export class FakeProvider extends BaseProvider {
  readonly key = 'fake';
  readonly airlineIata = ['XX'];
  readonly capabilities: ProviderCapabilities = {
    status: true,
    gate: true,
    baggage: false,
    schedule: true,
  };
  protected readonly cacheTtlMs = 60_000;
  fetchCount = 0;

  constructor(private readonly opts: { fail?: boolean; raw?: unknown } = {}) {
    super();
  }

  protected async fetchRaw(_q: FlightStatusQuery): Promise<unknown> {
    this.fetchCount += 1;
    if (this.opts.fail) throw new Error('upstream boom');
    return this.opts.raw ?? normalizedFixture();
  }

  protected normalize(raw: unknown): NormalizedFlightStatus | null {
    return raw as NormalizedFlightStatus;
  }
}
