import { sql } from '@flytrace/db';
import { AppError, correlationId, isAppError, uuidv7 } from '@flytrace/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { AppContext } from './context.ts';
import { createFlightsRoutes } from './flights/routes.ts';
import { type TicketPayload, signTicket } from './ws/ticket.ts';

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

  // ── WebSocket ticket (docs/12 §12.7) ──
  // Short-lived, single-use handshake credential. Guests get a public-channel
  // ticket; once Better Auth lands (Phase 1), an authenticated session upgrades
  // this to a user/admin ticket bound to the session's userId.
  app.post('/api/v1/ws/ticket', async (c) => {
    const now = ctx.clock.now();
    const ttlMs = 60_000;
    const payload: TicketPayload = {
      uid: null,
      role: 'guest',
      iat: now,
      exp: now + ttlMs,
      jti: uuidv7(now),
      bind: '',
    };
    const token = await signTicket(payload, ctx.config.AUTH_SECRET);
    return c.json({
      data: { token, expiresInMs: ttlMs },
      meta: { requestId: c.get('requestId') },
    });
  });

  // ── Public flight read endpoints (docs/11 §11.6) ──
  app.route('/api/v1', createFlightsRoutes(ctx));

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
