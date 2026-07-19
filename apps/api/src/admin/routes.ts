import { createSystemRepo, sql } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireRole } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';
import { readFlightDebug } from './flight-debug.ts';

/**
 * Admin console API (docs/11 §11.6, docs/03 §3.4.7). Role-gated. Reads the
 * operational picture from what's already persisted/queued: platform counts,
 * BullMQ queue depths (Redis), provider rows, and recent flights.
 */
export function createAdminRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const system = createSystemRepo(ctx.db);
  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId') } });

  app.use('/admin/*', requireRole('admin'));

  app.get('/admin/stats', async (c) => {
    const rows = (await ctx.db.execute(sql`
      select
        (select count(*) from users)               as users,
        (select count(*) from flights)             as flights,
        (select count(*) from flight_positions)    as positions,
        (select count(*) from flight_events)       as events,
        (select count(*) from notifications)       as notifications,
        (select count(*) from flights where status = 'active') as "activeFlights"
    `)) as unknown as Record<string, number>[];
    return ok(c, { stats: rows[0] ?? {} });
  });

  app.get('/admin/queues', async (c) => {
    const p = 'bull:provider.fetch'; // BullMQ uses its own 'bull' prefix, not the env prefix
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      ctx.redis.llen(`${p}:wait`),
      ctx.redis.llen(`${p}:active`),
      ctx.redis.zcard(`${p}:completed`),
      ctx.redis.zcard(`${p}:failed`),
      ctx.redis.zcard(`${p}:delayed`),
    ]);
    return ok(c, {
      queues: [{ name: 'provider.fetch', waiting, active, completed, failed, delayed }],
    });
  });

  app.get('/admin/providers', async (c) => {
    const rows = (await ctx.db.execute(sql`
      select key, name, enabled, health, circuit_state as "circuitState",
             last_success_at as "lastSuccessAt", last_error as "lastError"
      from providers order by key
    `)) as unknown as unknown[];
    return ok(c, { providers: rows });
  });

  app.get('/admin/flights', async (c) => {
    const rows = (await ctx.db.execute(sql`
      select id as "flightId", callsign, status, to_char(flight_date,'YYYY-MM-DD') as "flightDate",
             last_seen_at as "lastSeenAt"
      from flights order by last_seen_at desc nulls last limit 50
    `)) as unknown as unknown[];
    return ok(c, { flights: rows });
  });

  app.get('/admin/debug/flights/:icao24', async (c) => {
    return ok(c, { flight: await readFlightDebug(ctx, c.req.param('icao24')) });
  });

  const requireQueue = () => {
    if (!ctx.providerQueue) throw new AppError('INTERNAL', 'queue not available');
    return ctx.providerQueue;
  };

  // Dead-letter browser: failed provider.fetch jobs (docs/03 §3.4.7, docs/17 §17.4).
  app.get('/admin/dlq', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 200);
    const jobs = await requireQueue().getFailed(0, limit - 1);
    return ok(c, {
      jobs: jobs.map((j) => ({
        id: j.id,
        name: j.name,
        data: j.data,
        failedReason: j.failedReason,
        attemptsMade: j.attemptsMade,
        timestamp: j.timestamp,
        processedOn: j.processedOn ?? null,
      })),
    });
  });

  // Retry a single failed job.
  app.post('/admin/dlq/:jobId/retry', async (c) => {
    const jobId = c.req.param('jobId');
    const job = await requireQueue().getJob(jobId);
    if (!job) throw new AppError('NOT_FOUND', `job ${jobId} not found`);
    await job.retry();
    await audit(c, 'dlq.retry', jobId);
    return ok(c, { retried: jobId });
  });

  // Retry every failed job (bounded batch).
  app.post('/admin/dlq/retry-all', async (c) => {
    const queue = requireQueue();
    const jobs = await queue.getFailed(0, 499);
    const results = await Promise.allSettled(jobs.map((j) => j.retry()));
    const retried = results.filter((r) => r.status === 'fulfilled').length;
    await audit(c, 'dlq.retry-all', null, { count: retried });
    return ok(c, { retried, failed: results.length - retried });
  });

  // Provider traffic log (health scoring, ToS audit; docs/08 §8.9).
  app.get('/admin/logs', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    return ok(c, { logs: await system.recentProviderLogs(limit) });
  });

  // Admin audit trail (who did what; docs/15).
  app.get('/admin/audit', async (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    return ok(c, { audit: await system.recentAuditLogs(limit) });
  });

  /** Append an admin audit entry for a mutating action; best-effort. */
  async function audit(
    c: Context<AppEnv>,
    action: string,
    entityId: string | null,
    after?: unknown,
  ): Promise<void> {
    try {
      await system.insertAuditLog({
        actorUserId: c.get('user')?.id ?? null,
        actorType: 'admin',
        action,
        entity: 'provider.fetch',
        entityId,
        after: after ?? null,
        correlationId: c.get('requestId'),
      });
    } catch (err) {
      ctx.logger.warn('audit write failed', { action, err: String(err) });
    }
  }

  return app;
}
