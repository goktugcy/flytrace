import { createSystemRepo, sql } from '@flytrace/db';
import { type AirspaceImportJob, AppError, QUEUES } from '@flytrace/shared';
import type { Job, Queue } from 'bullmq';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { requireRole } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';
import { readFlightDebug } from './flight-debug.ts';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function emptyQueueCounts() {
  return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
}

async function queueCounts(queue: Queue | undefined, name: string) {
  const empty = { name, ...emptyQueueCounts() };
  if (!queue) return { ...empty, error: 'queue not available' };
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
    return {
      name,
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  } catch (err) {
    return { ...empty, error: errorMessage(err) };
  }
}

async function serializeAirspaceImportJob(job: Job) {
  return {
    id: job.id,
    name: job.name,
    state: await job.getState(),
    data: job.data as AirspaceImportJob,
    progress: job.progress,
    failedReason: job.failedReason ?? null,
    attemptsMade: job.attemptsMade,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    returnvalue: job.returnvalue ?? null,
  };
}

async function serializeAirspaceImportJobs(jobs: Job[]) {
  const results = await Promise.allSettled(jobs.map(serializeAirspaceImportJob));
  return results.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    const job = jobs[index];
    return {
      id: job?.id ?? `unreadable-${index}`,
      name: job?.name ?? 'unknown',
      state: 'unknown',
      data: job?.data as AirspaceImportJob | undefined,
      progress: {},
      failedReason: errorMessage(result.reason),
      attemptsMade: job?.attemptsMade ?? 0,
      timestamp: job?.timestamp ?? Date.now(),
      processedOn: job?.processedOn ?? null,
      finishedOn: job?.finishedOn ?? null,
      returnvalue: null,
    };
  });
}

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

  const defaultOpenAipDatasetVersion = () =>
    `openaip-global-${new Date().toISOString().slice(0, 10)}`;

  const airspaceImportStartSchema = z
    .object({
      datasetVersion: z.string().min(1).max(120).optional(),
    })
    .optional();

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
    const [provider, airspace] = await Promise.all([
      queueCounts(ctx.providerQueue, QUEUES.providerFetch),
      queueCounts(ctx.airspaceImportQueue, QUEUES.airspaceImport),
    ]);
    return ok(c, {
      queues: [provider, airspace],
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

  app.get('/admin/airspace/imports', async (c) => {
    const queue = ctx.airspaceImportQueue;
    const data: {
      configured: boolean;
      counts: ReturnType<typeof emptyQueueCounts>;
      jobs: Awaited<ReturnType<typeof serializeAirspaceImportJobs>>;
      error?: string;
    } = {
      configured: Boolean(ctx.config.OPENAIP_API_KEY),
      counts: emptyQueueCounts(),
      jobs: [],
    };
    if (!queue) {
      data.error = 'airspace import queue not available';
      return ok(c, data);
    }
    try {
      const counts = await queue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      data.counts = {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
      };
      const jobs = await queue.getJobs(
        ['active', 'waiting', 'delayed', 'completed', 'failed'],
        0,
        9,
      );
      data.jobs = await serializeAirspaceImportJobs(jobs);
    } catch (err) {
      data.error = errorMessage(err);
      ctx.logger.warn('airspace import queue read failed', { err: data.error });
    }
    return ok(c, data);
  });

  app.post('/admin/airspace/imports/openaip-global', async (c) => {
    const queue = requireAirspaceImportQueue();
    if (!ctx.config.OPENAIP_API_KEY) {
      throw new AppError('BAD_REQUEST', 'OPENAIP_API_KEY is required before starting import');
    }

    const active = await queue.getJobs(['active', 'waiting', 'delayed'], 0, 0);
    if (active[0]) {
      return c.json(
        {
          data: { job: await serializeAirspaceImportJob(active[0]), existing: true },
          meta: { requestId: c.get('requestId') },
        },
        202,
      );
    }

    const parsed = airspaceImportStartSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      throw new AppError('VALIDATION_ERROR', 'invalid airspace import request', {
        details: parsed.error.issues,
      });
    }
    const datasetVersion = parsed.data?.datasetVersion ?? defaultOpenAipDatasetVersion();
    const jobData: AirspaceImportJob = {
      provider: 'openaip',
      scope: 'global',
      datasetVersion,
      triggeredByUserId: c.get('user')?.id ?? null,
      requestedAt: new Date().toISOString(),
    };
    const job = await queue.add('openaip.global', jobData, {
      attempts: 1,
      removeOnComplete: 20,
      removeOnFail: 100,
    });
    await audit(c, 'airspace.import.start', job.id ?? null, {
      provider: 'openaip',
      scope: 'global',
      datasetVersion,
    });
    return c.json(
      {
        data: { job: await serializeAirspaceImportJob(job), existing: false },
        meta: { requestId: c.get('requestId') },
      },
      202,
    );
  });

  app.get('/admin/debug/flights/:icao24', async (c) => {
    return ok(c, { flight: await readFlightDebug(ctx, c.req.param('icao24')) });
  });

  const requireQueue = () => {
    if (!ctx.providerQueue) throw new AppError('INTERNAL', 'queue not available');
    return ctx.providerQueue;
  };

  const requireAirspaceImportQueue = () => {
    if (!ctx.airspaceImportQueue)
      throw new AppError('INTERNAL', 'airspace import queue not available');
    return ctx.airspaceImportQueue;
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
        entity: action.startsWith('airspace.') ? 'airspace.import' : 'provider.fetch',
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
