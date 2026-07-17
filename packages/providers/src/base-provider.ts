import { CircuitBreaker, type CircuitConfig } from './circuit-breaker.ts';
import {
  type FlightProvider,
  type FlightStatusQuery,
  type FlightStatusResult,
  type NormalizedFlightStatus,
  type ProviderCapabilities,
  type ProviderContext,
  type ProviderHealth,
  cacheKey,
  normalizedFlightStatusSchema,
} from './types.ts';

/**
 * All provider cross-cutting behavior (docs/08 §8.4/§8.8): read-through cache,
 * per-provider rate limiting, circuit breaking, single-flight coalescing, and
 * structured logging. A concrete provider supplies only `fetchRaw` + `normalize`
 * (+ `cacheTtlMs`). getFlightStatus never throws — on failure it serves cache or
 * null so a flaky provider can't take down the caller.
 */
export abstract class BaseProvider implements FlightProvider {
  abstract readonly key: string;
  abstract readonly airlineIata: string[];
  abstract readonly capabilities: ProviderCapabilities;

  protected abstract readonly cacheTtlMs: number;
  protected abstract fetchRaw(q: FlightStatusQuery): Promise<unknown>;
  protected abstract normalize(raw: unknown, q: FlightStatusQuery): NormalizedFlightStatus | null;

  protected ctx!: ProviderContext;
  private readonly breaker: CircuitBreaker;
  private readonly inflight = new Map<string, Promise<FlightStatusResult | null>>();

  constructor(circuit?: CircuitConfig) {
    this.breaker = new CircuitBreaker(circuit);
  }

  async init(ctx: ProviderContext): Promise<void> {
    this.ctx = ctx;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return this.breaker.current === 'open'
      ? 'down'
      : this.breaker.current === 'half-open'
        ? 'degraded'
        : 'up';
  }

  get circuitState() {
    return this.breaker.current;
  }

  async getFlightStatus(q: FlightStatusQuery): Promise<FlightStatusResult | null> {
    const key = cacheKey(this.key, q);

    // 1) Fresh cache hit (TTL enforced by the cache) short-circuits everything.
    const cached = await this.readCache(key);
    if (cached) return { status: cached, cached: true };

    // 2) Circuit open → fail fast (no upstream call).
    if (!this.breaker.canRequest(this.ctx.clock.now())) {
      this.ctx.logger.warn('provider circuit open', { provider: this.key });
      return null;
    }

    // 3) Rate-limit budget (shared across replicas via the limiter).
    if (!(await this.ctx.rateLimiter.tryAcquire(`provider:rl:${this.key}`))) {
      this.ctx.logger.warn('provider rate limited', { provider: this.key });
      return null;
    }

    // 4) Single-flight: coalesce concurrent requests for the same key.
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.fetchAndCache(key, q);
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  private async fetchAndCache(
    key: string,
    q: FlightStatusQuery,
  ): Promise<FlightStatusResult | null> {
    try {
      const raw = await this.fetchRaw(q);
      const status = this.normalize(raw, q);
      this.breaker.recordSuccess();
      if (!status) return null;
      await this.ctx.cache.set(key, JSON.stringify(status), this.cacheTtlMs);
      return { status, cached: false };
    } catch (err) {
      this.breaker.recordFailure(this.ctx.clock.now());
      this.ctx.logger.error('provider fetch failed', { provider: this.key, err: String(err) });
      return null;
    }
  }

  private async readCache(key: string): Promise<NormalizedFlightStatus | null> {
    const raw = await this.ctx.cache.get(key);
    if (!raw) return null;
    try {
      const parsed = normalizedFlightStatusSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
