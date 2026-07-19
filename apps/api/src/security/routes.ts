import type { AuthUser } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { clearSessionCookie } from '../auth/cookie.ts';
import { requireUser } from '../auth/routes.ts';
import type { AuditLog } from './edge/audit-log.ts';
import { InMemoryRateLimiter, type RateLimiter, rateLimitMiddleware } from './edge/rate-limit.ts';
import { validateJson } from './edge/validation.ts';
import type {
  EnrollmentConfirmed,
  EnrollmentStart,
  MfaService,
  VerifyMethod,
} from './mfa/mfa-service.ts';
import type { DeviceRecord, DeviceService } from './session/devices.ts';
import type { RefreshTokenService } from './session/refresh-tokens.ts';

type MfaPort = Pick<
  MfaService,
  'beginEnrollment' | 'confirmEnrollment' | 'verify' | 'regenerateBackupCodes' | 'disable'
>;
type DevicePort = Pick<DeviceService, 'listDevices' | 'revokeDevice'>;
type RefreshTokenPort = Pick<
  RefreshTokenService,
  'revoke' | 'revokeAllForUser' | 'revokeAllForDevice'
>;

export interface SecurityRoutesDeps {
  mfa: MfaPort;
  devices: DevicePort;
  refreshTokens: RefreshTokenPort;
  audit: AuditLog;
  verifyPassword: (user: AuthUser, password: string) => Promise<void>;
  revokeSession: (sessionToken: string | undefined) => Promise<void>;
  rateLimiter?: RateLimiter | undefined;
}

export interface SecurityRoutesOptions {
  allowedOrigins: string[];
  rateLimitMax?: number | undefined;
  rateLimitWindowMs?: number | undefined;
}

const tokenBody = z.object({ token: z.string().min(1).max(128) });
const passwordBody = z.object({ password: z.string().min(1).max(200) });
const refreshTokenBody = z.object({ token: z.string().min(1).max(1024) });
const CSP_REPORT_MAX_BYTES = 8 * 1024;
const cspReportPayload = z
  .object({
    'document-uri': z.string().max(2048).optional(),
    'effective-directive': z.string().max(256).optional(),
    'violated-directive': z.string().max(256).optional(),
    'blocked-uri': z.string().max(2048).optional(),
    'source-file': z.string().max(2048).optional(),
    disposition: z.string().max(64).optional(),
    'line-number': z.number().int().nonnegative().max(1_000_000).optional(),
  })
  .passthrough();

function csrfGuard(allowedOrigins: string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin && !allowedOrigins.includes(origin)) {
        throw new AppError('FORBIDDEN', 'cross-origin request rejected');
      }
    }
    await next();
  };
}

function currentUser(c: Context<AppEnv>): AuthUser {
  const user = c.get('user');
  if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
  return user;
}

function clientIp(c: Context<AppEnv>): string | undefined {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? undefined;
}

function serializeDevice(device: DeviceRecord) {
  return {
    id: device.id,
    fingerprint: device.fingerprint,
    ua: device.ua,
    lastIp: device.lastIp,
    trusted: device.trusted,
    lastSeenAt: device.lastSeenAt.toISOString(),
    createdAt: device.createdAt.toISOString(),
  };
}

async function recordAudit(
  deps: SecurityRoutesDeps,
  c: Context<AppEnv>,
  action: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const user = currentUser(c);
  await deps.audit.record({
    actorId: user.id,
    action,
    target: `user:${user.id}`,
    ip: clientIp(c),
    ...(meta ? { meta } : {}),
  });
}

function safeUrlForAudit(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 2048);
  if (
    trimmed === 'inline' ||
    trimmed === 'eval' ||
    trimmed === 'self' ||
    trimmed === 'wasm-eval' ||
    /^[a-z][a-z0-9+.-]*:$/i.test(trimmed)
  ) {
    return trimmed;
  }
  try {
    const url = new URL(trimmed);
    return `${url.origin}${url.pathname}`.slice(0, 2048);
  } catch {
    return trimmed.slice(0, 512);
  }
}

async function parseCspReport(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const raw = await c.req.text().catch(() => '');
  if (raw.length > CSP_REPORT_MAX_BYTES) {
    throw new AppError('BAD_REQUEST', 'csp report too large', { httpStatus: 413 });
  }
  const json = JSON.parse(raw || '{}') as unknown;
  const envelope = Array.isArray(json) ? json[0] : json;
  const root =
    envelope && typeof envelope === 'object' ? (envelope as Record<string, unknown>) : {};
  const report = root['csp-report'] ?? root.body ?? root;
  const parsed = cspReportPayload.safeParse(report);
  if (!parsed.success) {
    throw new AppError('BAD_REQUEST', 'invalid csp report', { details: parsed.error.issues });
  }
  return {
    documentUri: safeUrlForAudit(parsed.data['document-uri']),
    effectiveDirective: parsed.data['effective-directive'],
    violatedDirective: parsed.data['violated-directive'],
    blockedUri: safeUrlForAudit(parsed.data['blocked-uri']),
    sourceFile: safeUrlForAudit(parsed.data['source-file']),
    disposition: parsed.data.disposition,
    lineNumber: parsed.data['line-number'],
  };
}

async function reauthenticate(
  deps: SecurityRoutesDeps,
  user: AuthUser,
  password: string,
): Promise<void> {
  await deps.verifyPassword(user, password);
}

export function createSecurityRoutes(
  deps: SecurityRoutesDeps,
  opts: SecurityRoutesOptions,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const limiter = deps.rateLimiter ?? new InMemoryRateLimiter();
  const rateLimitMax = opts.rateLimitMax ?? 20;
  const rateLimitWindowMs = opts.rateLimitWindowMs ?? 60_000;

  app.use('*', csrfGuard(opts.allowedOrigins));
  app.use(
    '/security/csp-report',
    rateLimitMiddleware({
      limiter,
      max: rateLimitMax,
      windowMs: rateLimitWindowMs,
      keyFn: (c) => `csp:${clientIp(c) ?? 'anon'}`,
    }),
  );

  app.post('/security/csp-report', async (c) => {
    let meta: Record<string, unknown>;
    try {
      meta = await parseCspReport(c);
    } catch (err) {
      if (err instanceof SyntaxError) throw new AppError('BAD_REQUEST', 'invalid csp report json');
      throw err;
    }
    await deps.audit.record({
      action: 'csp.violation_reported',
      ip: clientIp(c),
      meta,
    });
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } }, 202);
  });

  app.use('*', requireUser());
  app.use(
    '*',
    rateLimitMiddleware({
      limiter,
      max: rateLimitMax,
      windowMs: rateLimitWindowMs,
      keyFn: (c) => {
        const user = c.get('user');
        const ip = clientIp(c) ?? 'anon';
        return `security:${user?.id ?? 'anon'}:${ip}`;
      },
    }),
  );

  app.post('/security/mfa/setup', async (c) => {
    const user = currentUser(c);
    const data: EnrollmentStart = await deps.mfa.beginEnrollment(user.id, user.email);
    await recordAudit(deps, c, 'mfa.setup_started');
    return c.json({ data, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/mfa/confirm', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(tokenBody)(c);
    const data: EnrollmentConfirmed = await deps.mfa.confirmEnrollment(user.id, body.token);
    await recordAudit(deps, c, 'mfa.enabled', { backupCodeCount: data.backupCodes.length });
    return c.json({ data, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/mfa/verify', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(tokenBody)(c);
    const method: VerifyMethod = await deps.mfa.verify(user.id, body.token);
    await recordAudit(deps, c, 'mfa.challenge_verified', { method });
    return c.json({ data: { method }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/mfa/backup-codes/refresh', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    const data = await deps.mfa.regenerateBackupCodes(user.id);
    await recordAudit(deps, c, 'mfa.backup_codes_refreshed', {
      backupCodeCount: data.backupCodes.length,
    });
    return c.json({ data, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/mfa/disable', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    await deps.mfa.disable(user.id);
    await recordAudit(deps, c, 'mfa.disabled');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.get('/security/devices', async (c) => {
    const user = currentUser(c);
    const devices = await deps.devices.listDevices(user.id);
    return c.json({
      data: { items: devices.map(serializeDevice) },
      meta: { requestId: c.get('requestId') },
    });
  });

  app.delete('/security/devices/:id', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    const deviceId = c.req.param('id');
    await deps.refreshTokens.revokeAllForDevice(deviceId);
    await deps.devices.revokeDevice(deviceId);
    await recordAudit(deps, c, 'device.revoked', { deviceId });
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/refresh-tokens/revoke', async (c) => {
    const body = await validateJson(refreshTokenBody)(c);
    await deps.refreshTokens.revoke(body.token);
    await recordAudit(deps, c, 'refresh_token.revoked');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/refresh-tokens/revoke-all', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    await deps.refreshTokens.revokeAllForUser(user.id);
    await recordAudit(deps, c, 'refresh_tokens.revoked_all');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/security/sessions/revoke-current', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    await deps.revokeSession(c.get('sessionToken'));
    clearSessionCookie(c);
    await recordAudit(deps, c, 'session.revoked_current');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  return app;
}
