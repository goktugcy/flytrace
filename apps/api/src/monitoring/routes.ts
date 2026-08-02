/**
 * Operational endpoints (docs/11 §11.6, docs/14).
 *
 * Three tiers with deliberately different exposure:
 *
 *   - `GET /health`         PUBLIC liveness. "This process is running." No
 *                           dependency probing at all, because a liveness probe
 *                           that fails when the database blips causes the
 *                           orchestrator to restart a perfectly healthy process
 *                           and turn a dependency outage into a crash loop.
 *   - `GET /health/ready`   PUBLIC readiness. "This instance can serve traffic."
 *                           Probes the hard dependencies and answers 200/503
 *                           with a minimal `{ready, checks:{db,redis}}` body —
 *                           enough for a load balancer, not enough for recon.
 *   - `GET /health/detailed` INTERNAL. Every check with latency and detail.
 *   - `GET /metrics`         INTERNAL. Prometheus exposition.
 *
 * `/ready` is kept as an alias of `/health/ready` for existing probes.
 *
 * No response on any tier contains a connection string, a Redis URL, a secret,
 * an internal hostname, a stack trace or user data — {@link sanitizeDetail}
 * enforces that for the free-text `detail` fields, which are the only place
 * such a value could realistically leak (a driver error message).
 */
import { sql } from '@flytrace/db';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import {
  type HealthCheck,
  HealthChecker,
  type HealthReport,
  dbCheck,
  memoryCheck,
  queueCheck,
  redisCheck,
  wsCheck,
} from './health-checks.ts';
import { type InternalAccessDecision, internalAccessGuard } from './internal-auth.ts';

function resolveVersion(): string {
  return process.env.APP_VERSION ?? process.env.npm_package_version ?? process.env.GIT_SHA ?? 'dev';
}

/** Assemble the check set from whatever deps the context actually carries. */
export function buildChecksFromContext(ctx: AppContext): HealthCheck[] {
  const checks: HealthCheck[] = [];

  if (ctx.db) checks.push(dbCheck(() => ctx.db.execute(sql`select 1`)));
  if (ctx.redis) checks.push(redisCheck(() => ctx.redis.ping()));
  if (ctx.providerQueue) {
    const queue = ctx.providerQueue;
    checks.push(queueCheck(() => queue.getWaitingCount()));
  }
  checks.push(wsCheck(() => ctx.wsPresence?.count() ?? 0));
  checks.push(memoryCheck());

  return checks;
}

/**
 * Strip anything that could carry infrastructure detail out of a check's free-
 * text `detail`.
 *
 * A driver failure message is the realistic leak path here: postgres.js and
 * ioredis both like to echo the connection target, and a raw `String(err)` from
 * the aggregator can carry a stack. Rather than trusting every driver to be
 * discreet, unknown text is redacted to a fixed marker and only the check's own
 * structured summaries (`depth=`, `connections=`, `heap …`) pass through.
 */
export function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const safeShapes = [
    /^depth=\d+$/,
    /^connections=\d+$/,
    /^heap \d+(\.\d+)?% \(\d+\/\d+\)$/,
    /^timeout after \d+ms$/,
  ];
  if (safeShapes.some((re) => re.test(detail))) return detail;
  // Anything else (driver errors, unexpected ping replies) is reduced to a
  // status-only signal. Operators get the real cause from the logs, which are
  // not publicly reachable.
  return 'unavailable';
}

function sanitizeReport(report: HealthReport): HealthReport {
  const checks: HealthReport['checks'] = {};
  for (const [name, result] of Object.entries(report.checks)) {
    const detail = sanitizeDetail(result.detail);
    checks[name] = {
      status: result.status,
      latencyMs: result.latencyMs,
      ...(detail !== undefined ? { detail } : {}),
    };
  }
  return { ...report, checks };
}

export interface MonitoringRoutesOptions {
  internalAccess: InternalAccessDecision;
  /** Prometheus registry renderer for `/metrics`. */
  renderMetrics: () => string;
  /** Applied to the internal endpoints so a scraper cannot hammer them. */
  opsRateLimit?: Parameters<Hono<AppEnv>['use']>[1] | undefined;
}

export function createMonitoringRoutes(
  ctx: AppContext,
  opts: MonitoringRoutesOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const checker = new HealthChecker({
    checks: buildChecksFromContext(ctx),
    version: resolveVersion(),
  });

  // ── Public: liveness ───────────────────────────────────────────────────────
  // Intentionally dependency-free. Docker HEALTHCHECK and the orchestrator's
  // livenessProbe point here.
  app.get('/health', (c) => c.json({ status: 'ok', service: 'api', time: ctx.clock.nowIso() }));

  // ── Public: readiness ──────────────────────────────────────────────────────
  const readiness = async () => {
    const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };
    try {
      await ctx.db.execute(sql`select 1`);
      checks.db = 'ok';
    } catch (err) {
      // Logged, not returned: the driver message can name the host/database.
      ctx.logger.error('readiness: db check failed', { err: String(err) });
    }
    try {
      const pong = await ctx.redis.ping();
      checks.redis = pong === 'PONG' ? 'ok' : 'fail';
    } catch (err) {
      ctx.logger.error('readiness: redis check failed', { err: String(err) });
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return { ready, checks };
  };

  app.get('/health/ready', async (c) => {
    const result = await readiness();
    return c.json(result, result.ready ? 200 : 503);
  });
  // Backwards-compatible alias for existing probes.
  app.get('/ready', async (c) => {
    const result = await readiness();
    return c.json(result, result.ready ? 200 : 503);
  });

  // ── Internal: detailed health + metrics ────────────────────────────────────
  const guard = internalAccessGuard(opts.internalAccess);
  if (opts.opsRateLimit) {
    app.use('/health/detailed', opts.opsRateLimit);
    app.use('/metrics', opts.opsRateLimit);
  }
  app.use('/health/detailed', guard);
  app.use('/metrics', guard);

  app.get('/health/detailed', async (c) => {
    const report = sanitizeReport(await checker.run());
    return c.json(report, report.status === 'down' ? 503 : 200);
  });

  app.get('/metrics', (c) =>
    c.text(opts.renderMetrics(), 200, {
      'content-type': 'text/plain; version=0.0.4',
      // Never let a proxy or browser retain a metrics snapshot.
      'cache-control': 'no-store',
    }),
  );

  return app;
}
