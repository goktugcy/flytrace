import type { AuthUser } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import {
  type CookieOptions,
  clearRefreshCookie,
  clearSessionCookie,
  getRefreshToken,
} from '../auth/cookie.ts';
import { requireUser } from '../auth/routes.ts';
import type { SignInFlow } from '../auth/sign-in-flow.ts';
import type { AuditLog } from './edge/audit-log.ts';
import {
  type PolicyMiddlewareDeps,
  policyRateLimit,
  clientIp as trustedClientIp,
} from './edge/rate-limit-policies.ts';
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
type FlowPort = Pick<SignInFlow, 'revokeAllAfterCredentialChange'>;

/** One active session, as shown to its owner. Carries no token material. */
export interface SessionSummaryView {
  id: string;
  deviceId: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface SecurityRoutesDeps {
  mfa: MfaPort;
  devices: DevicePort;
  refreshTokens: RefreshTokenPort;
  audit: AuditLog;
  /**
   * Shared post-auth pipeline — the single implementation of "invalidate every
   * credential", used by both the password change and the MFA disable.
   */
  flow: FlowPort;
  verifyPassword: (user: AuthUser, password: string) => Promise<void>;
  /** Replace the credentials password hash. Callers revoke sessions after. */
  changePassword: (userId: string, newPassword: string) => Promise<void>;
  listSessions: (userId: string) => Promise<SessionSummaryView[]>;
  revokeSession: (sessionToken: string | undefined) => Promise<void>;
  /** Terminate sessions bound to a device being revoked. */
  revokeDeviceSessions: (deviceId: string) => Promise<number>;
}

export interface SecurityRoutesOptions {
  allowedOrigins: string[];
  /**
   * The process-wide limiter and its policies. These routes deliberately do NOT
   * construct their own limiter: a private in-memory counter would not be
   * shared across API instances, so the limit would silently scale with the
   * replica count.
   */
  rateLimit: PolicyMiddlewareDeps;
  cookies: CookieOptions;
}

const tokenBody = z.object({ token: z.string().min(1).max(128) });
const passwordBody = z.object({ password: z.string().min(1).max(200) });
/** Mirrors the sign-up policy so a password cannot be *weakened* by changing it. */
const changePasswordBody = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(8).max(200),
});
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
  const ip = trustedClientIp(c);
  return ip === 'unknown' ? undefined : ip;
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

  app.use('*', csrfGuard(opts.allowedOrigins));
  app.use(
    '/security/csp-report',
    policyRateLimit(opts.rateLimit, 'cspReport', (c) => [clientIp(c)]),
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
    policyRateLimit(opts.rateLimit, 'security', (c) => [c.get('user')?.id, clientIp(c)]),
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

  /**
   * Step-up verification for an ALREADY authenticated session (re-confirming
   * the second factor before a sensitive action). This is not the login flow:
   * sign-in MFA is redeemed at `POST /api/auth/mfa/verify`, which needs no
   * session because it is what creates one.
   */
  app.post(
    '/security/mfa/verify',
    policyRateLimit(opts.rateLimit, 'mfaVerify', (c) => [c.get('user')?.id, clientIp(c)]),
    async (c) => {
      const user = currentUser(c);
      const body = await validateJson(tokenBody)(c);
      try {
        const method: VerifyMethod = await deps.mfa.verify(user.id, body.token);
        await recordAudit(deps, c, 'mfa.step_up_verified', { method });
        return c.json({ data: { method }, meta: { requestId: c.get('requestId') } });
      } catch (err) {
        await recordAudit(deps, c, 'mfa.step_up_failed');
        throw err;
      }
    },
  );

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

  /**
   * Disabling MFA weakens the account, so every existing credential is
   * invalidated: whoever turned it off must re-authenticate under the new
   * (weaker) rules, and any session an attacker was holding dies with it.
   * The user is notified out of band.
   */
  app.post('/security/mfa/disable', async (c) => {
    const user = currentUser(c);
    const body = await validateJson(passwordBody)(c);
    await reauthenticate(deps, user, body.password);
    await deps.mfa.disable(user.id);
    await recordAudit(deps, c, 'mfa.disabled');
    await deps.flow.revokeAllAfterCredentialChange(user.id, 'mfa_disabled', {
      ip: clientIp(c) ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    clearSessionCookie(c, opts.cookies);
    clearRefreshCookie(c, opts.cookies);
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  /**
   * Change the account password.
   *
   * Rate-limited under the `passwordReset` policy (5/hour) because it is a
   * credential-guessing surface: `currentPassword` is verified here, so an
   * attacker holding only a session cookie could otherwise brute-force the
   * password from inside the account.
   *
   * On success EVERY session and refresh token is destroyed — including the
   * caller's. A password change that left the old sessions alive would be
   * useless against an attacker who already holds a session cookie, which is
   * the single most common reason people change a password in the first place.
   * The user is signed out and must re-authenticate with the new password.
   */
  app.post(
    '/security/password',
    policyRateLimit(opts.rateLimit, 'passwordReset', (c) => [c.get('user')?.id, clientIp(c)]),
    async (c) => {
      const user = currentUser(c);
      const body = await validateJson(changePasswordBody)(c);

      if (body.newPassword === body.currentPassword) {
        throw new AppError('BAD_REQUEST', 'the new password must differ from the current one');
      }

      try {
        await reauthenticate(deps, user, body.currentPassword);
      } catch (err) {
        await recordAudit(deps, c, 'password.change_failed');
        throw err;
      }

      await deps.changePassword(user.id, body.newPassword);
      await recordAudit(deps, c, 'password.changed');
      await deps.flow.revokeAllAfterCredentialChange(user.id, 'password_changed', {
        ip: clientIp(c) ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
      clearSessionCookie(c, opts.cookies);
      clearRefreshCookie(c, opts.cookies);

      return c.json({
        data: { ok: true, signedOutEverywhere: true },
        meta: { requestId: c.get('requestId') },
      });
    },
  );

  /**
   * The caller's own active sessions, so "where am I signed in?" is answerable
   * before deciding to sign out everywhere. Returns no token material — only
   * the coarsened IP that `SECURITY_IP_STORAGE` allowed us to persist.
   */
  app.get('/security/sessions', async (c) => {
    const user = currentUser(c);
    const items = await deps.listSessions(user.id);
    return c.json({ data: { items }, meta: { requestId: c.get('requestId') } });
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
    // A device is only really revoked when BOTH of its credentials die: the
    // refresh token that would mint new sessions, and the sessions already
    // issued to it. Revoking one without the other leaves a usable foothold.
    const owned = (await deps.devices.listDevices(user.id)).some((d) => d.id === deviceId);
    if (!owned) throw new AppError('NOT_FOUND', 'device not found');
    await deps.refreshTokens.revokeAllForDevice(deviceId);
    const sessions = await deps.revokeDeviceSessions(deviceId);
    await deps.devices.revokeDevice(deviceId);
    await recordAudit(deps, c, 'device.revoked', { deviceId, sessionsRevoked: sessions });
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  /**
   * Revoke the caller's own refresh token. The token comes from the cookie, not
   * the body: accepting an arbitrary token here would let any authenticated
   * user revoke another user's credential by guessing (or replaying) it.
   */
  app.post('/security/refresh-tokens/revoke', async (c) => {
    const token = getRefreshToken(c);
    if (token) await deps.refreshTokens.revoke(token);
    clearRefreshCookie(c, opts.cookies);
    await recordAudit(deps, c, 'refresh_token.revoked');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  /** "Sign out everywhere": every refresh token AND every session. */
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
    const refresh = getRefreshToken(c);
    if (refresh) await deps.refreshTokens.revoke(refresh);
    clearSessionCookie(c, opts.cookies);
    clearRefreshCookie(c, opts.cookies);
    await recordAudit(deps, c, 'session.revoked_current');
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  return app;
}
