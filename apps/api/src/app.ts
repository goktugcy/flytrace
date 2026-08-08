import {
  type AuthUser,
  createAesGcmMfaSecretCodec,
  createAuthRepo,
  createNotifyRepo,
  createSecurityAuditRepo,
  createSecurityDeviceRepo,
  createSecurityMfaRepo,
  createSecurityRefreshTokenRepo,
} from '@flytrace/db';
import { EmailChannel, HttpEmailTransport } from '@flytrace/notifications';
import { AppError, correlationId, createTracer, isAppError, uuidv7 } from '@flytrace/shared';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { createAdminRoutes } from './admin/routes.ts';
import { createAirportOpsRoutes } from './airport-ops/routes.ts';
import { createAirspaceRoutes } from './airspace/routes.ts';
import type { CookieOptions } from './auth/cookie.ts';
import {
  NoopPasswordResetMailer,
  type PasswordResetMailer,
  PasswordResetService,
  TransportPasswordResetMailer,
} from './auth/password-reset.ts';
import { attachSession, createAuthRoutes } from './auth/routes.ts';
import { AuthService, bunHasher } from './auth/service.ts';
import { SignInFlow } from './auth/sign-in-flow.ts';
import { createCatalogRoutes } from './catalog/routes.ts';
import type { AppContext } from './context.ts';
import { createFlightsRoutes } from './flights/routes.ts';
import { createApiMetrics } from './metrics.ts';
import { resolveInternalAccess } from './monitoring/internal-auth.ts';
import { tracingMiddleware } from './monitoring/request-tracing.ts';
import { createMonitoringRoutes } from './monitoring/routes.ts';
import { createNotifyRoutes } from './notify/routes.ts';
import { createTelegramRoutes } from './notify/telegram.ts';
import { DbAuditLog, InMemoryAuditLog } from './security/edge/audit-log.ts';
import { buildCsp } from './security/edge/headers.ts';
import {
  type PolicyMiddlewareDeps,
  buildRateLimitPolicies,
  clientIp,
  ipRateLimit,
} from './security/edge/rate-limit-policies.ts';
import { resolveRateLimiter } from './security/edge/rate-limit.ts';
import { CloudflareTurnstile, MockTurnstile } from './security/edge/turnstile.ts';
import { MfaChallengeService, resolveMfaChallengeStore } from './security/mfa/challenge.ts';
import { MfaService } from './security/mfa/mfa-service.ts';
import { createSecurityRoutes } from './security/routes.ts';
import { DeviceService } from './security/session/devices.ts';
import {
  RefreshTokenService,
  randomToken as randomRefreshToken,
  sha256TokenHasher,
} from './security/session/refresh-tokens.ts';
import {
  ChannelSecurityNotifier,
  NoopSecurityNotifier,
  type SecurityNotifier,
} from './security/session/security-notifier.ts';
import { createUserRoutes } from './user/routes.ts';
import { createWeatherRoutes } from './weather/routes.ts';
import { type TicketPayload, signTicket } from './ws/ticket.ts';

const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AppEnv {
  Variables: {
    requestId: string;
    ctx: AppContext;
    user: AuthUser | null;
    sessionToken: string | undefined;
  };
}

type AppConfig = AppContext['config'];

function configuredCspHeaderName(mode: string | undefined): string | null {
  if (mode === 'report-only') return 'Content-Security-Policy-Report-Only';
  if (mode === 'enforce') return 'Content-Security-Policy';
  return null;
}

function buildApiCsp(config: AppConfig): string {
  const turnstileSources = config.TURNSTILE_ENABLED ? [TURNSTILE_ORIGIN] : [];
  return buildCsp({
    connectSrc: [
      ...(config.CORS_ORIGINS ?? []),
      ...(config.CSP_CONNECT_SRC ?? []),
      ...turnstileSources,
    ],
    imgSrc: config.CSP_IMG_SRC ?? [],
    scriptSrc: [...(config.CSP_SCRIPT_SRC ?? []), ...turnstileSources],
    styleSrc: config.CSP_STYLE_SRC ?? [],
    fontSrc: config.CSP_FONT_SRC ?? [],
    frameSrc: [...(config.CSP_FRAME_SRC ?? []), ...turnstileSources],
    reportUri: config.CSP_REPORT_URI,
  });
}

/**
 * Build the security notifier. Without a configured email transport there is
 * nothing to deliver on, so we fall back to a no-op recorder rather than
 * pretending alerts are going out.
 */
function buildSecurityNotifier(ctx: AppContext): SecurityNotifier {
  if (!ctx.config.SECURITY_NOTIFICATIONS_ENABLED || !ctx.config.EMAIL_API_KEY) {
    if (ctx.config.SECURITY_NOTIFICATIONS_ENABLED) {
      ctx.logger.warn(
        'security notifications are enabled but no EMAIL_API_KEY is configured — new-device and token-reuse alerts will not be delivered',
      );
    }
    return new NoopSecurityNotifier();
  }
  const transport = new HttpEmailTransport({
    apiKey: ctx.config.EMAIL_API_KEY,
    apiUrl: ctx.config.EMAIL_API_URL,
  });
  return new ChannelSecurityNotifier({
    repo: createNotifyRepo(ctx.db),
    channels: [
      {
        key: 'email',
        adapter: new EmailChannel({
          from: ctx.config.EMAIL_FROM,
          transport,
          webBaseUrl: ctx.config.WEB_BASE_URL,
        }),
      },
    ],
    logger: ctx.logger,
  });
}

export function createApp(ctx: AppContext) {
  const app = new Hono<AppEnv>();

  // ── Composition root ───────────────────────────────────────────────────────
  // Every security adapter is selected exactly once, here. Route modules
  // receive what they need; none of them constructs its own limiter, store or
  // notifier — that is how the security routes previously ended up with a
  // private in-memory limiter no other instance could see.

  const authRepo = createAuthRepo(ctx.db);
  const authService = new AuthService({
    repo: authRepo,
    clock: ctx.clock,
    hasher: bunHasher,
    sessionTtlMs: ctx.config.SESSION_TTL_DAYS * DAY_MS,
  });
  const mfaSecretCodec = createAesGcmMfaSecretCodec(
    ctx.config.MFA_SECRET_ENCRYPTION_KEY || ctx.config.AUTH_SECRET,
  );
  const mfaService = new MfaService({
    repo: createSecurityMfaRepo(ctx.db, mfaSecretCodec),
    clock: ctx.clock,
    issuer: ctx.config.MFA_ISSUER,
  });
  const mfaChallenges = new MfaChallengeService({
    store: resolveMfaChallengeStore(
      {
        MFA_CHALLENGE_BACKEND: ctx.config.MFA_CHALLENGE_BACKEND,
        APP_ENV: ctx.config.APP_ENV,
      },
      {
        redis: ctx.redis,
        prefix: ctx.redisPrefix,
        logger: ctx.logger,
      },
    ),
    clock: ctx.clock,
    ttlMs: ctx.config.MFA_CHALLENGE_TTL_SECONDS * 1000,
    maxAttempts: ctx.config.MFA_MAX_ATTEMPTS,
  });
  const deviceService = new DeviceService({
    repo: createSecurityDeviceRepo(ctx.db),
    clock: ctx.clock,
    ipPolicy: ctx.config.SECURITY_IP_STORAGE,
  });
  const refreshTokenService = new RefreshTokenService({
    repo: createSecurityRefreshTokenRepo(ctx.db),
    clock: ctx.clock,
    random: randomRefreshToken,
    hasher: sha256TokenHasher,
    ttlMs: ctx.config.SESSION_REFRESH_TTL_DAYS * DAY_MS,
    reuseGraceMs: ctx.config.REFRESH_TOKEN_REUSE_GRACE_MS,
  });
  const auditLog =
    ctx.config.AUDIT_BACKEND === 'db'
      ? new DbAuditLog(createSecurityAuditRepo(ctx.db), ctx.clock)
      : new InMemoryAuditLog(ctx.clock);
  const securityNotifier = buildSecurityNotifier(ctx);

  // ONE rate limiter for the whole process, shared across every policy and by
  // the sign-in flow's challenge guard. Built before its consumers.
  const rateLimiter = resolveRateLimiter(
    { RATE_LIMIT_BACKEND: ctx.config.RATE_LIMIT_BACKEND, APP_ENV: ctx.config.APP_ENV },
    { redis: ctx.redis, prefix: `${ctx.redisPrefix}rl:`, logger: ctx.logger },
  );
  const rateLimit: PolicyMiddlewareDeps = {
    limiter: rateLimiter,
    policies: buildRateLimitPolicies(ctx.config),
    logger: ctx.logger,
  };

  const signInFlow = new SignInFlow({
    auth: authService,
    mfa: mfaService,
    challenges: mfaChallenges,
    devices: deviceService,
    refreshTokens: refreshTokenService,
    audit: auditLog,
    notifier: securityNotifier,
    clock: ctx.clock,
    logger: ctx.logger,
    ipPolicy: ctx.config.SECURITY_IP_STORAGE,
    impossibleTravelMaxKmh: ctx.config.IMPOSSIBLE_TRAVEL_MAX_KMH,
    // Bounds challenge minting per account — see SignInFlow.guardChallengeIssuance.
    // Reads the shared policy table rather than the raw config, so every limit
    // in the system has exactly one definition.
    challengeLimiter: {
      limiter: rateLimiter,
      max: rateLimit.policies.mfaChallenge.max,
      windowMs: rateLimit.policies.mfaChallenge.windowMs,
    },
  });

  // Forgotten-password reset. Without an email transport the link cannot be
  // delivered, so we record instead of pretending it went out.
  const resetMailer: PasswordResetMailer = ctx.config.EMAIL_API_KEY
    ? new TransportPasswordResetMailer({
        from: ctx.config.EMAIL_FROM,
        transport: new HttpEmailTransport({
          apiKey: ctx.config.EMAIL_API_KEY,
          apiUrl: ctx.config.EMAIL_API_URL,
        }),
      })
    : new NoopPasswordResetMailer();
  if (!ctx.config.EMAIL_API_KEY && ctx.config.APP_ENV !== 'local') {
    ctx.logger.warn(
      'no EMAIL_API_KEY configured — password reset links cannot be delivered outside local development',
    );
  }
  const passwordResetService = new PasswordResetService({
    repo: authRepo,
    mailer: resetMailer,
    audit: auditLog,
    clock: ctx.clock,
    logger: ctx.logger,
    hashPassword: (password) => bunHasher.hash(password),
    flow: signInFlow,
    webBaseUrl: ctx.config.WEB_BASE_URL,
    ttlMinutes: ctx.config.PASSWORD_RESET_TTL_MINUTES,
    ipPolicy: ctx.config.SECURITY_IP_STORAGE,
  });

  if (
    ctx.config.TURNSTILE_ENABLED &&
    !ctx.config.TURNSTILE_SECRET &&
    ctx.config.APP_ENV !== 'local'
  ) {
    throw new Error('TURNSTILE_SECRET is required when TURNSTILE_ENABLED=true outside local');
  }
  const turnstileVerifier = ctx.config.TURNSTILE_SECRET
    ? new CloudflareTurnstile({ secret: ctx.config.TURNSTILE_SECRET })
    : new MockTurnstile();

  const cookies: CookieOptions = {
    secure: ctx.config.APP_ENV !== 'local',
    sameSite: ctx.config.SESSION_COOKIE_SAMESITE,
    domain: ctx.config.SESSION_COOKIE_DOMAIN,
  };

  const metrics = ctx.metrics ?? createApiMetrics();
  const tracer = createTracer(ctx.config, { logger: ctx.logger });

  // Fails fast if /metrics and /health/detailed would be publicly readable.
  const internalAccess = resolveInternalAccess(ctx.config);
  ctx.logger.info('operational endpoints protected', { mode: internalAccess.mode });

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
    // Path only — never the query string, headers or body: those carry tokens.
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

  // Baseline public-API limit, keyed by client IP. Sensitive endpoints layer
  // their own stricter policy on top (see the auth and security route modules).
  app.use('/api/*', ipRateLimit(rateLimit, 'api'));

  app.use('*', secureHeaders());
  const cspHeaderName = configuredCspHeaderName(ctx.config.CSP_MODE);
  const csp = cspHeaderName ? buildApiCsp(ctx.config) : null;
  if (cspHeaderName && csp) {
    app.use('*', async (c, next) => {
      await next();
      c.header(cspHeaderName, csp);
    });
  }
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

  // ── Auth: credentials, MFA step-up, refresh rotation (docs/15 §15.1) ──
  app.route(
    '/api/auth',
    createAuthRoutes(signInFlow, {
      allowedOrigins: ctx.config.CORS_ORIGINS,
      cookies,
      rateLimit,
      passwordReset: passwordResetService,
      turnstile: {
        verifier: turnstileVerifier,
        enabled: ctx.config.TURNSTILE_ENABLED,
        failOpen: ctx.config.TURNSTILE_FAIL_OPEN,
        expectedAction: ctx.config.TURNSTILE_EXPECTED_ACTION,
        expectedHostname: ctx.config.TURNSTILE_EXPECTED_HOSTNAME,
      },
    }),
  );

  // ── Operational endpoints: /health, /health/ready, /health/detailed, /metrics ──
  app.route(
    '/',
    createMonitoringRoutes(ctx, {
      internalAccess,
      renderMetrics: () => metrics.registry.render(),
      opsRateLimit: ipRateLimit(rateLimit, 'ops'),
    }),
  );

  app.get('/api/v1', (c) =>
    c.json({
      data: { name: 'FlyTrace API', version: 'v1' },
      meta: { requestId: c.get('requestId') },
    }),
  );

  // ── WebSocket ticket (docs/12 §12.7) ──
  // Short-lived, single-use handshake credential. Guests get a public-channel
  // ticket; an authenticated session upgrades this to a user/admin ticket bound
  // to the session's userId. Single-use enforcement (jti) lives in the gateway.
  app.post('/api/v1/ws/ticket', ipRateLimit(rateLimit, 'wsTicket'), async (c) => {
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

  // Current authenticated user. Carries `mfaEnabled` so the security settings
  // screen can render the right state without a second round trip; it is a
  // boolean about the caller's own account, never the secret or backup codes.
  app.get('/api/v1/me', async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'not signed in');
    const mfaEnabled = await mfaService.isEnabled(user.id).catch(() => false);
    return c.json({
      data: { user: { ...user, mfaEnabled } },
      meta: { requestId: c.get('requestId') },
    });
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

  // ── Airport ground operations (Phase 5) ──
  app.route('/api/v1', createAirportOpsRoutes(ctx));

  // ── Current weather and modelled aviation risk (Open-Meteo) ──
  app.route('/api/v1', createWeatherRoutes());

  // ── Security: MFA enrolment, devices, session/refresh revocation ──
  app.route(
    '/api/v1',
    createSecurityRoutes(
      {
        mfa: mfaService,
        devices: deviceService,
        refreshTokens: refreshTokenService,
        audit: auditLog,
        flow: signInFlow,
        verifyPassword: async (user, password) => {
          const found = await authRepo.findUserByEmail(user.email);
          if (!found?.passwordHash || !(await bunHasher.verify(password, found.passwordHash))) {
            throw new AppError('UNAUTHENTICATED', 'reauthentication failed');
          }
        },
        changePassword: async (userId, newPassword) => {
          // Same KDF as sign-up — the password path never touches the fast
          // token digest used for session/refresh tokens.
          await authRepo.updatePasswordHash(userId, await bunHasher.hash(newPassword));
        },
        listSessions: (userId) => authRepo.listSessionsForUser(userId),
        revokeSession: (sessionToken) => authService.signOut(sessionToken),
        revokeDeviceSessions: (deviceId) => authService.signOutDevice(deviceId),
      },
      {
        allowedOrigins: ctx.config.CORS_ORIGINS,
        rateLimit,
        cookies,
      },
    ),
  );

  // ── Admin console (role=admin; docs/11 §11.6) ──
  app.use('/api/v1/admin/*', ipRateLimit(rateLimit, 'admin'));
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
    // Only the request id reaches the client; the message could name a host,
    // a query, or a token that appeared in a driver error.
    ctx.logger.error('unhandled error', { requestId, err: String(err) });
    return c.json(new AppError('INTERNAL', 'Internal error').toEnvelope(requestId), 500);
  });

  return app;
}

export { clientIp };
