/**
 * Client reconnect strategy (docs/12 §12.8). Pure and framework-free so it can
 * be shared with the browser client and unit-tested deterministically (the RNG
 * is injectable). The server-side resume window (`resumeWindowMs` in the hub)
 * pairs with this: the client backs off, reconnects, and replays from its last
 * cursor.
 */

export interface BackoffOptions {
  /** Base delay in ms (attempt 0). */
  base: number;
  /** Upper bound on the delay in ms. */
  max: number;
  /** Fraction of jitter in [0, 1]; the delay is drawn from `[raw*(1-jitter), raw]`. */
  jitter?: number;
  /** Zero-based retry attempt. */
  attempt: number;
  /** Injectable RNG in [0, 1) (default `Math.random`). */
  rng?: () => number;
}

/**
 * Exponential backoff with optional jitter: `min(max, base * 2^attempt)`, then
 * jittered downward. Never returns more than `max` or less than 0.
 */
export function exponentialBackoff(opts: BackoffOptions): number {
  const attempt = Math.max(0, Math.floor(opts.attempt));
  const jitter = clamp01(opts.jitter ?? 0);
  const rng = opts.rng ?? Math.random;
  // 2^attempt can overflow to Infinity; min() with a finite `max` clamps it.
  const raw = Math.min(opts.max, opts.base * 2 ** attempt);
  if (jitter <= 0) return Math.round(raw);
  const floor = raw * (1 - jitter);
  return Math.round(floor + rng() * (raw - floor));
}

function clamp01(n: number): number {
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export type ReconnectState = 'connected' | 'reconnecting' | 'given_up';

export interface ReconnectDecision {
  /** Whether the client should schedule another attempt. */
  retry: boolean;
  /** Delay before the next attempt in ms (0 when `retry` is false). */
  delayMs: number;
  /** The attempt number this decision is for (1-based). */
  attempt: number;
  state: ReconnectState;
}

export interface ReconnectPolicyOptions extends Omit<BackoffOptions, 'attempt'> {
  /** Max attempts before giving up; omit/≤0 for unlimited. */
  maxAttempts?: number;
}

/**
 * Small state machine driving reconnect. `onClose` advances the attempt counter
 * and returns the next delay (or gives up); `onOpen` resets it. Holds no timers
 * — the caller schedules `delayMs` — so it stays pure and testable.
 */
export class ReconnectPolicy {
  private state: ReconnectState = 'connected';
  private attempt = 0;
  private readonly maxAttempts: number;

  constructor(private readonly opts: ReconnectPolicyOptions) {
    this.maxAttempts =
      opts.maxAttempts && opts.maxAttempts > 0 ? opts.maxAttempts : Number.POSITIVE_INFINITY;
  }

  get currentState(): ReconnectState {
    return this.state;
  }

  get attempts(): number {
    return this.attempt;
  }

  /** Connection established: clear the backoff. */
  onOpen(): void {
    this.state = 'connected';
    this.attempt = 0;
  }

  /** Connection lost: compute the next backoff, or give up past `maxAttempts`. */
  onClose(): ReconnectDecision {
    if (this.attempt >= this.maxAttempts) {
      this.state = 'given_up';
      return { retry: false, delayMs: 0, attempt: this.attempt, state: this.state };
    }
    this.attempt += 1;
    this.state = 'reconnecting';
    const delayMs = exponentialBackoff({
      base: this.opts.base,
      max: this.opts.max,
      attempt: this.attempt - 1,
      ...(this.opts.jitter !== undefined ? { jitter: this.opts.jitter } : {}),
      ...(this.opts.rng ? { rng: this.opts.rng } : {}),
    });
    return { retry: true, delayMs, attempt: this.attempt, state: this.state };
  }

  /** Reset to the initial connected state. */
  reset(): void {
    this.state = 'connected';
    this.attempt = 0;
  }
}
