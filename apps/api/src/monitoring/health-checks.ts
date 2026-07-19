/**
 * Health aggregation for the deep `/health/detailed` probe (docs/11 §11.6,
 * docs/14 observability). A {@link HealthChecker} runs a set of named, injectable
 * async checks in parallel, each guarded by a timeout, and folds their outcomes
 * into a single status. Checks NEVER throw out of the aggregator: an exception or
 * a timeout is caught and downgraded to `degraded` so the probe always answers.
 *
 * Aggregation rule:
 *   - any check `down`      → overall `down`
 *   - else any `degraded`   → overall `degraded`
 *   - else                  → overall `ok`
 *
 * Everything is dependency-injected (checks, clock, uptime source, timeout) so
 * the logic is unit-testable with fakes and requires no live dependency.
 */

export type HealthStatus = 'ok' | 'degraded' | 'down';

/** What an individual check reports. Latency is measured by the aggregator. */
export interface CheckOutcome {
  status: HealthStatus;
  detail?: string;
}

/** A named, runnable check. `check` should resolve to a {@link CheckOutcome}. */
export interface HealthCheck {
  name: string;
  check: () => Promise<CheckOutcome>;
}

/** Per-check result surfaced in the report. */
export interface CheckResult {
  status: HealthStatus;
  latencyMs: number;
  detail?: string;
}

export interface HealthReport {
  status: HealthStatus;
  checks: Record<string, CheckResult>;
  uptimeSec: number;
  version: string;
}

export interface HealthCheckerOptions {
  checks: HealthCheck[];
  /** Reported build/version string. Default `'dev'`. */
  version?: string;
  /** Per-check timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Monotonic-ish clock for latency measurement. Default `Date.now`. */
  now?: () => number;
  /** Process uptime in seconds. Default `process.uptime`. */
  uptimeFn?: () => number;
}

const DEFAULT_TIMEOUT_MS = 2000;

export class HealthChecker {
  private readonly checks: HealthCheck[];
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly uptimeFn: () => number;

  constructor(opts: HealthCheckerOptions) {
    this.checks = opts.checks;
    this.version = opts.version ?? 'dev';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.uptimeFn = opts.uptimeFn ?? (() => process.uptime());
  }

  async run(): Promise<HealthReport> {
    const entries = await Promise.all(this.checks.map((chk) => this.runOne(chk)));

    const checks: Record<string, CheckResult> = {};
    for (const { name, result } of entries) checks[name] = result;

    const statuses = entries.map((e) => e.result.status);
    const status: HealthStatus = statuses.includes('down')
      ? 'down'
      : statuses.includes('degraded')
        ? 'degraded'
        : 'ok';

    return {
      status,
      checks,
      uptimeSec: Math.max(0, Math.floor(this.uptimeFn())),
      version: this.version,
    };
  }

  private async runOne(chk: HealthCheck): Promise<{ name: string; result: CheckResult }> {
    const start = this.now();
    try {
      const outcome = await this.withTimeout(chk.check());
      return {
        name: chk.name,
        result: {
          status: outcome.status,
          latencyMs: Math.max(0, this.now() - start),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        },
      };
    } catch (err) {
      // A failing check must never bubble — degrade gracefully.
      return {
        name: chk.name,
        result: {
          status: 'degraded',
          latencyMs: Math.max(0, this.now() - start),
          detail: `check failed: ${String(err)}`,
        },
      };
    }
  }

  private async withTimeout(p: Promise<CheckOutcome>): Promise<CheckOutcome> {
    // Swallow a late rejection so a timed-out check can't raise an
    // unhandledRejection after the race has already settled.
    p.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CheckOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve({ status: 'degraded', detail: `timeout after ${this.timeoutMs}ms` }),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

// ── Check factories ────────────────────────────────────────────────────────
// Each returns a HealthCheck built around an injected probe fn, so the same
// factory serves both production wiring and unit tests (with fakes).

/** DB liveness: runs the injected ping (e.g. `SELECT 1`); ok if it resolves. */
export function dbCheck(pingFn: () => Promise<unknown>, opts: { name?: string } = {}): HealthCheck {
  return {
    name: opts.name ?? 'db',
    check: async () => {
      await pingFn();
      return { status: 'ok' };
    },
  };
}

/** Redis liveness: expects the injected ping to return `'PONG'`. */
export function redisCheck(
  pingFn: () => Promise<string>,
  opts: { name?: string } = {},
): HealthCheck {
  return {
    name: opts.name ?? 'redis',
    check: async () => {
      const pong = await pingFn();
      return pong === 'PONG'
        ? { status: 'ok' }
        : { status: 'degraded', detail: `unexpected ping reply: ${pong}` };
    },
  };
}

/**
 * Queue depth: `degraded` when depth ≥ warnDepth, `down` when depth ≥ downDepth.
 * Depth is surfaced in `detail` regardless.
 */
export function queueCheck(
  depthFn: () => Promise<number> | number,
  opts: { name?: string; warnDepth?: number; downDepth?: number } = {},
): HealthCheck {
  const warn = opts.warnDepth ?? 1000;
  const down = opts.downDepth ?? Number.POSITIVE_INFINITY;
  return {
    name: opts.name ?? 'queue',
    check: async () => {
      const depth = await depthFn();
      const status: HealthStatus = depth >= down ? 'down' : depth >= warn ? 'degraded' : 'ok';
      return { status, detail: `depth=${depth}` };
    },
  };
}

/** WebSocket connection count — informational; always `ok`, count in `detail`. */
export function wsCheck(
  countFn: () => Promise<number> | number,
  opts: { name?: string } = {},
): HealthCheck {
  return {
    name: opts.name ?? 'ws',
    check: async () => {
      const count = await countFn();
      return { status: 'ok', detail: `connections=${count}` };
    },
  };
}

/**
 * Process heap pressure: `degraded` at warnRatio, `down` at downRatio of
 * heapUsed/heapTotal. `usageFn` is injectable for deterministic tests.
 */
export function memoryCheck(
  opts: {
    name?: string;
    warnRatio?: number;
    downRatio?: number;
    usageFn?: () => { heapUsed: number; heapTotal: number };
  } = {},
): HealthCheck {
  const usageFn = opts.usageFn ?? (() => process.memoryUsage());
  const warn = opts.warnRatio ?? 0.9;
  const down = opts.downRatio ?? 0.98;
  return {
    name: opts.name ?? 'memory',
    check: async () => {
      const { heapUsed, heapTotal } = usageFn();
      const ratio = heapTotal > 0 ? heapUsed / heapTotal : 0;
      const status: HealthStatus = ratio >= down ? 'down' : ratio >= warn ? 'degraded' : 'ok';
      return {
        status,
        detail: `heap ${(ratio * 100).toFixed(1)}% (${heapUsed}/${heapTotal})`,
      };
    },
  };
}
