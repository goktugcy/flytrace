import { sql } from '@flytrace/db';
import { AppError, correlationId, isAppError } from '@flytrace/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppContext } from './context.ts';

export interface AppEnv {
  Variables: { requestId: string; ctx: AppContext };
}

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  // ── Middleware chain (see docs/11-api.md §11.10) ──
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? correlationId();
    c.set('requestId', requestId);
    c.set('ctx', ctx);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    ctx.logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - start,
    });
  });

  app.use('*', secureHeaders());
  app.use(
    '/api/*',
    cors({
      origin: ctx.config.CORS_ORIGINS,
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  // ── System routes ──
  app.get('/health', (c) => c.json({ status: 'ok', service: 'api', time: ctx.clock.nowIso() }));

  app.get('/ready', async (c) => {
    const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };
    try {
      await ctx.db.execute(sql`select 1`);
      checks.db = 'ok';
    } catch (err) {
      ctx.logger.error('readiness: db check failed', { err: String(err) });
    }
    try {
      const pong = await ctx.redis.ping();
      checks.redis = pong === 'PONG' ? 'ok' : 'fail';
    } catch (err) {
      ctx.logger.error('readiness: redis check failed', { err: String(err) });
    }
    const ready = Object.values(checks).every((v) => v === 'ok');
    return c.json({ ready, checks }, ready ? 200 : 503);
  });

  app.get('/api/v1', (c) =>
    c.json({
      data: { name: 'FlyTrace API', version: 'v1' },
      meta: { requestId: c.get('requestId') },
    }),
  );

  // ── Fallbacks & error mapping ──
  app.notFound((c) =>
    c.json(new AppError('NOT_FOUND', 'Route not found').toEnvelope(c.get('requestId')), 404),
  );

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    if (isAppError(err)) {
      if (err.httpStatus >= 500)
        ctx.logger.error('app error', { requestId, code: err.code, msg: err.message });
      return c.json(err.toEnvelope(requestId), err.httpStatus as 400);
    }
    ctx.logger.error('unhandled error', { requestId, err: String(err) });
    return c.json(new AppError('INTERNAL', 'Internal error').toEnvelope(requestId), 500);
  });

  return app;
}
