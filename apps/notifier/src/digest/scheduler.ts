/**
 * Digest scheduler (docs/10, docs/17 §17.5). Cron-less but interface-ready: a
 * real cron/queue trigger can implement {@link DigestScheduler} later. The
 * default {@link IntervalDigestScheduler} uses an injectable timer + clock and
 * an injectable retry helper, so a full tick can be driven synchronously in a
 * test with zero real time elapsed.
 */

export interface DigestScheduler {
  start(): void;
  stop(): void;
}

/** Retry helper contract: run `fn` up to N attempts with backoff between them. */
export interface RetryOptions {
  attempts: number;
  /** Backoff before attempt N (1-based, N>=2). Default: 200ms * 2^(N-2). */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
}

export type RetryFn = <T>(fn: () => Promise<T>, opts?: Partial<RetryOptions>) => Promise<T>;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Build a retry helper. Attempts a function up to `attempts` times; on the last
 * failure the error is rethrown so the caller (scheduler/queue) can react.
 */
export function createRetry(defaults: Partial<RetryOptions> = {}): RetryFn {
  const attemptsDefault = defaults.attempts ?? 3;
  const backoffDefault = defaults.backoffMs ?? ((n: number) => 200 * 2 ** (n - 2));
  const sleep = defaults.sleep ?? defaultSleep;
  return async <T>(fn: () => Promise<T>, opts: Partial<RetryOptions> = {}): Promise<T> => {
    const attempts = opts.attempts ?? attemptsDefault;
    const backoffMs = opts.backoffMs ?? backoffDefault;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) await sleep(backoffMs(attempt));
      try {
        return await fn();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  };
}

/** Injectable timer so tests never touch the real event loop. */
export interface SchedulerTimer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimer: SchedulerTimer = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface SchedulerLogger {
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
}

export interface IntervalDigestSchedulerDeps {
  intervalMs: number;
  /** Enumerate the users whose digest is due right now. */
  listDueUsers: () => Promise<string[]> | string[];
  /** Send one user's digest (typically DigestService.sendDigest, bound). */
  sendDigest: (userId: string) => Promise<unknown>;
  /** Retry helper wrapping each send (defaults to createRetry()). */
  retry?: RetryFn;
  timer?: SchedulerTimer;
  logger?: SchedulerLogger;
}

export class IntervalDigestScheduler implements DigestScheduler {
  private handle: unknown = null;
  private running = false;
  private readonly retry: RetryFn;
  private readonly timer: SchedulerTimer;

  constructor(private readonly deps: IntervalDigestSchedulerDeps) {
    this.retry = deps.retry ?? createRetry();
    this.timer = deps.timer ?? realTimer;
  }

  start(): void {
    if (this.handle !== null) return;
    this.handle = this.timer.setInterval(() => {
      // Fire-and-forget: a slow tick must not block the timer. Errors are logged.
      void this.tick();
    }, this.deps.intervalMs);
    this.deps.logger?.info?.('digest-scheduler: started', { intervalMs: this.deps.intervalMs });
  }

  stop(): void {
    if (this.handle === null) return;
    this.timer.clearInterval(this.handle);
    this.handle = null;
    this.deps.logger?.info?.('digest-scheduler: stopped');
  }

  /**
   * One scheduling cycle: enumerate due users and send each with retry. Skips
   * re-entrancy if a previous tick is still in flight. Individual send failures
   * are isolated so one bad user can't sink the batch. Returns per-user results.
   */
  async tick(): Promise<{ userId: string; ok: boolean }[]> {
    if (this.running) {
      this.deps.logger?.warn?.('digest-scheduler: tick skipped (previous still running)');
      return [];
    }
    this.running = true;
    const results: { userId: string; ok: boolean }[] = [];
    try {
      const users = await this.deps.listDueUsers();
      for (const userId of users) {
        try {
          await this.retry(() => this.deps.sendDigest(userId) as Promise<unknown>);
          results.push({ userId, ok: true });
        } catch (err) {
          this.deps.logger?.error?.('digest-scheduler: send failed', {
            userId,
            error: err instanceof Error ? err.message : String(err),
          });
          results.push({ userId, ok: false });
        }
      }
    } finally {
      this.running = false;
    }
    return results;
  }
}
