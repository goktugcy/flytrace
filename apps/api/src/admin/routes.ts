import { sql } from '@flytrace/db';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { requireRole } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';

/**
 * Admin console API (docs/11 §11.6, docs/03 §3.4.7). Role-gated. Reads the
 * operational picture from what's already persisted/queued: platform counts,
 * BullMQ queue depths (Redis), provider rows, and recent flights.
 */
export function createAdminRoutes(ctx: AppContext): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
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

  return app;
}
