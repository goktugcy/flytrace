/**
 * Deep health route (docs/11 §11.6). `GET /health/detailed` returns the full
 * aggregated {@link HealthReport} — every dependency probed, with per-check
 * status/latency — for dashboards and alerting. The shallow `/health` and
 * `/ready` probes in app.ts stay untouched; this is the verbose sibling.
 *
 * Checks are wired from the app context with graceful fallback: an absent
 * dependency (e.g. no provider queue) simply contributes no check rather than
 * failing the probe. The endpoint answers 200 unless the overall status is
 * `down`, in which case it answers 503 so load balancers can act.
 */
import { sql } from '@flytrace/db';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import {
  type HealthCheck,
  HealthChecker,
  dbCheck,
  memoryCheck,
  queueCheck,
  redisCheck,
  wsCheck,
} from './health-checks.ts';

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
  // WS connection count isn't directly readable from the metrics Gauge; wire a
  // best-effort informational probe (0 when unknown) so the check is present.
  checks.push(wsCheck(() => 0));
  checks.push(memoryCheck());

  return checks;
}

export function createMonitoringRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const checker = new HealthChecker({
    checks: buildChecksFromContext(ctx),
    version: resolveVersion(),
  });

  app.get('/health/detailed', async (c) => {
    const report = await checker.run();
    return c.json(report, report.status === 'down' ? 503 : 200);
  });

  return app;
}
