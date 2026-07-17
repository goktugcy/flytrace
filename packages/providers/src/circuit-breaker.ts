/**
 * Per-provider circuit breaker (docs/08 §8.7): closed → open (after N
 * consecutive failures) → half-open (after a cooldown) → closed on success.
 * Pure and clock-injected (the caller passes `now`) for deterministic tests.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitConfig {
  failureThreshold: number;
  openMs: number;
}

export const DEFAULT_CIRCUIT: CircuitConfig = { failureThreshold: 5, openMs: 30_000 };

export class CircuitBreaker {
  private failures = 0;
  private openedAt = 0;
  private state: CircuitState = 'closed';

  constructor(private readonly cfg: CircuitConfig = DEFAULT_CIRCUIT) {}

  /** May a request proceed now? Transitions open→half-open once cooled down. */
  canRequest(now: number): boolean {
    if (this.state === 'open') {
      if (now - this.openedAt >= this.cfg.openMs) {
        this.state = 'half-open';
        return true; // allow a single probe
      }
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.state = 'closed';
  }

  recordFailure(now: number): void {
    this.failures += 1;
    if (this.state === 'half-open' || this.failures >= this.cfg.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  get current(): CircuitState {
    return this.state;
  }
}
