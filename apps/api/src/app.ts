import { type AuthUser, createAuthRepo, sql } from '@flytrace/db';
import { AppError, correlationId, createTracer, isAppError, uuidv7 } from '@flytrace/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createAdminRoutes } from './admin/routes.ts';
import { createAirspaceRoutes } from './airspace/routes.ts';
import { attachSession, createAuthRoutes } from './auth/routes.ts';
import { AuthService, bunHasher } from './auth/service.ts';
import { createCatalogRoutes } from './catalog/routes.ts';
import type { AppContext } from './context.ts';
import { createFlightsRoutes } from './flights/routes.ts';
import { createApiMetrics } from './metrics.ts';
import { tracingMiddleware } from './monitoring/request-tracing.ts';
import { createMonitoringRoutes } from './monitoring/routes.ts';
import { createNotifyRoutes } from './notify/routes.ts';
import { createTelegramRoutes } from './notify/telegram.ts';
import { createUserRoutes } from './user/routes.ts';
import { type TicketPayload, signTicket } from './ws/ticket.ts';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface AppEnv {
  Variables: {
    requestId: string;
    ctx: AppContext;
    user: AuthUser | null;
    sessionToken: string | undefined;
  };
}

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  const authService = new AuthService({
    repo: createAuthRepo(ctx.db),
    clock: ctx.clock,
    hasher: bunHasher,
    sessionTtlMs: SESSION_TTL_MS,
  });
  const cookieSecure = ctx.config.APP_ENV !== 'local';
  const metrics = ctx.metrics ?? createApiMetrics();
  const tracer = createTracer(ctx.config, { logger: ctx.logger });

  // ── Middleware chain (see docs/11-api.md §11.10) ──
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? correlationId();
    c.set('requestId', requestId);
    c.set('ctx', ctx);
    c.header('x-request-id', requestId);
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    metrics.httpRequests.inc({ method: c.req.method, status: String(c.res.status) });
    metrics.httpDuration.observe(ms / 1000, { method: c.req.method });
    ctx.logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms,
    });
  });

  // Wrap every request in a tracing span (noop unless OTEL_* configured).
  app.use('*', tracingMiddleware(tracer));

  app.use('*', secureHeaders());
  // In local dev, also reflect private-LAN origins so a phone on the same
  // network (e.g. http://192.168.x.x:3000) can reach the API. Configured
  // CORS_ORIGINS are always allowed; everything else is rejected.
  const allowed = new Set(ctx.config.CORS_ORIGINS);
  const isLocal = ctx.config.APP_ENV === 'local';
  const lanOrigin =
    /^https?:\/\/(localhost|127\.0\.0\.1|(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.[\d.]+)(?::\d+)?$/;
  app.use(
    '/api/*',
    cors({
      origin: (origin) => {
        if (!origin) return ctx.config.CORS_ORIGINS[0] ?? null;
        if (allowed.has(origin)) return origin;
        if (isLocal && lanOrigin.test(origin)) return origin;
        return null;
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  // Populate c.var.user from the session cookie (best-effort; skips DB when absent).
  app.use('*', attachSession(authService));

  // ── Auth (credentials + server sessions; docs/15 §15.1) ──
  app.route(
    '/api/auth',
    createAuthRoutes(authService, { allowedOrigins: ctx.config.CORS_ORIGINS, cookieSecure }),
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

  // Prometheus metrics (internal network only in prod; docs/11 §11.6, docs/14).
  app.get('/metrics', (c) =>
    c.text(metrics.registry.render(), 200, { 'content-type': 'text/plain; version=0.0.4' }),
  );

  // Detailed health JSON (db/redis/queue/ws/memory) — GET /health/detailed.
  app.route('/', createMonitoringRoutes(ctx));

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
    const user = c.get('user');
    const payload: TicketPayload = {
      uid: user?.id ?? null,
      role: user ? (user.role === 'admin' ? 'admin' : 'user') : 'guest',
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

  // Current authenticated user.
  app.get('/api/v1/me', (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'not signed in');
    return c.json({ data: { user }, meta: { requestId: c.get('requestId') } });
  });

  // ── Public flight read endpoints (docs/11 §11.6) ──
  app.route('/api/v1', createFlightsRoutes(ctx));

  // ── Watchlist / channels / notifications (docs/10) ──
  app.route('/api/v1', createNotifyRoutes(ctx));

  // ── Telegram linking + webhook (docs/10 §10.6) ──
  app.route('/', createTelegramRoutes(ctx));

  // ── User: favorites / settings / channels / dashboard (docs/11 §11.6) ──
  app.route('/api/v1', createUserRoutes(ctx));

  // ── Catalog: airport / aircraft pages (docs/11 §11.6) ──
  app.route('/api/v1', createCatalogRoutes(ctx));

  // ── Airspace lookup (Phase 3 §1: EnteredAirspace) ──
  app.route('/api/v1', createAirspaceRoutes(ctx));

  // ── Admin console (role=admin; docs/11 §11.6) ──
  app.route('/api/v1', createAdminRoutes(ctx));

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
