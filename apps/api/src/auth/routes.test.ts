import { describe, expect, test } from 'bun:test';
import { AppError, createLogger, fixedClock, hashToken, isAppError } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { InMemoryAuditLog } from '../security/edge/audit-log.ts';
import {
  type PolicyMiddlewareDeps,
  buildRateLimitPolicies,
} from '../security/edge/rate-limit-policies.ts';
import { InMemoryRateLimiter } from '../security/edge/rate-limit.ts';
import { MockTurnstile } from '../security/edge/turnstile.ts';
import { InMemoryMfaChallengeStore, MfaChallengeService } from '../security/mfa/challenge.ts';
import type { VerifyMethod } from '../security/mfa/mfa-service.ts';
import { DeviceService, createInMemoryDeviceRepo } from '../security/session/devices.ts';
import {
  RefreshTokenService,
  createInMemoryRefreshTokenRepo,
} from '../security/session/refresh-tokens.ts';
import { NoopSecurityNotifier } from '../security/session/security-notifier.ts';
import { attachSession, createAuthRoutes } from './routes.ts';
import { AuthService, type Hasher } from './service.ts';
import { SignInFlow } from './sign-in-flow.ts';
import { InMemoryAuthRepo } from './testing.ts';

const fakeHasher: Hasher = {
  hash: async (pw) => `h:${pw}`,
  verify: async (pw, h) => h === `h:${pw}`,
};

const RATE_LIMIT_CONFIG = {
  RATE_LIMIT_MAX: 1000,
  RATE_LIMIT_WINDOW_MS: 60_000,
  RATE_LIMIT_LOGIN_MAX: 1000,
  RATE_LIMIT_LOGIN_WINDOW_MS: 60_000,
  RATE_LIMIT_SIGNUP_MAX: 1000,
  RATE_LIMIT_SIGNUP_WINDOW_MS: 60_000,
  RATE_LIMIT_MFA_CHALLENGE_MAX: 1000,
  RATE_LIMIT_MFA_CHALLENGE_WINDOW_MS: 60_000,
  RATE_LIMIT_MFA_VERIFY_MAX: 1000,
  RATE_LIMIT_MFA_VERIFY_WINDOW_MS: 60_000,
  RATE_LIMIT_REFRESH_MAX: 1000,
  RATE_LIMIT_REFRESH_WINDOW_MS: 60_000,
  RATE_LIMIT_PASSWORD_RESET_MAX: 1000,
  RATE_LIMIT_PASSWORD_RESET_WINDOW_MS: 60_000,
  RATE_LIMIT_WS_TICKET_MAX: 1000,
  RATE_LIMIT_WS_TICKET_WINDOW_MS: 60_000,
  RATE_LIMIT_SECURITY_MAX: 1000,
  RATE_LIMIT_SECURITY_WINDOW_MS: 60_000,
  RATE_LIMIT_ADMIN_MAX: 1000,
  RATE_LIMIT_ADMIN_WINDOW_MS: 60_000,
  RATE_LIMIT_OPS_MAX: 1000,
  RATE_LIMIT_OPS_WINDOW_MS: 60_000,
};

/** Scriptable MFA stand-in: which users have MFA, and which codes are valid. */
class FakeMfa {
  enabledUsers = new Set<string>();
  validTotp = '123456';
  backupCodes = new Set<string>();
  /** Force `isEnabled` to blow up, to prove sign-in fails closed. */
  isEnabledThrows = false;

  async isEnabled(userId: string): Promise<boolean> {
    if (this.isEnabledThrows) throw new Error('mfa store unavailable');
    return this.enabledUsers.has(userId);
  }

  async verify(userId: string, code: string): Promise<VerifyMethod> {
    if (!this.enabledUsers.has(userId)) {
      throw new AppError('BAD_REQUEST', 'MFA is not enabled for this user');
    }
    if (code === this.validTotp) return 'totp';
    if (this.backupCodes.has(code)) {
      this.backupCodes.delete(code); // one-time use
      return 'backup_code';
    }
    throw new AppError('UNAUTHENTICATED', 'invalid MFA code');
  }
}

function buildApp(opts: { turnstileEnabled?: boolean; rateLimitOverrides?: object } = {}) {
  const clock = fixedClock(1_700_000_000_000);
  const repo = new InMemoryAuthRepo();
  repo.now = () => clock.now();

  const authService = new AuthService({
    repo,
    clock,
    hasher: fakeHasher,
    sessionTtlMs: 60_000,
  });
  const mfa = new FakeMfa();
  const challengeStore = new InMemoryMfaChallengeStore(() => clock.now());
  const challenges = new MfaChallengeService({
    store: challengeStore,
    clock,
    ttlMs: 300_000,
    maxAttempts: 3,
  });
  const devices = new DeviceService({ repo: createInMemoryDeviceRepo(), clock });
  const refreshRepo = createInMemoryRefreshTokenRepo();
  const refreshTokens = new RefreshTokenService({
    repo: refreshRepo,
    clock,
    random: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `rand${n}`;
      };
    })(),
    hasher: { hash: hashToken },
    ttlMs: 600_000,
    reuseGraceMs: 0, // strictest: every replay is treated as an attack
  });
  const audit = new InMemoryAuditLog(clock);
  const notifier = new NoopSecurityNotifier();

  const flow = new SignInFlow({
    auth: authService,
    mfa,
    challenges,
    devices,
    refreshTokens,
    audit,
    notifier,
    clock,
    logger: createLogger({ level: 'error' }),
  });

  const rateLimit: PolicyMiddlewareDeps = {
    limiter: new InMemoryRateLimiter(() => clock.now()),
    policies: buildRateLimitPolicies({ ...RATE_LIMIT_CONFIG, ...opts.rateLimitOverrides }),
  };

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test');
    await next();
  });
  app.use('*', attachSession(authService));
  app.route(
    '/',
    createAuthRoutes(flow, {
      allowedOrigins: ['http://localhost:3000'],
      cookies: { secure: false, sameSite: 'Lax' },
      rateLimit,
      turnstile: {
        verifier: new MockTurnstile(),
        enabled: opts.turnstileEnabled ?? false,
        failOpen: false,
        expectedAction: 'turnstile-spin-v1',
      },
    }),
  );
  app.onError((err, c) => {
    if (isAppError(err)) return c.json(err.toEnvelope('test'), err.httpStatus as 400);
    return c.json(new AppError('INTERNAL', 'x').toEnvelope('test'), 500);
  });

  return { app, mfa, repo, audit, clock, refreshRepo, notifier, devices };
}

const ORIGIN = { 'content-type': 'application/json', origin: 'http://localhost:3000' };

/** All Set-Cookie values, as a name→value map of the cookie pairs. */
function cookiesFrom(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

function cookieHeader(res: Response): string {
  return (res.headers.getSetCookie?.() ?? [])
    .map((raw) => raw.split(';')[0])
    .filter(Boolean)
    .join('; ');
}

async function signUp(app: Hono<AppEnv>, email = 'a@example.com', password = 'hunter2!') {
  return app.request('/sign-up', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ email, password }),
  });
}

async function signIn(app: Hono<AppEnv>, email = 'a@example.com', password = 'hunter2!') {
  return app.request('/sign-in', {
    method: 'POST',
    headers: ORIGIN,
    body: JSON.stringify({ email, password }),
  });
}

describe('auth routes — basics', () => {
  test('sign-up sets session + refresh cookies and /session reflects it', async () => {
    const { app } = buildApp();
    const up = await signUp(app);
    expect(up.status).toBe(201);

    const cookies = cookiesFrom(up);
    expect(cookies.flytrace_session).toBeTruthy();
    expect(cookies.flytrace_refresh).toBeTruthy();

    const sess = await app.request('/session', { headers: { cookie: cookieHeader(up) } });
    const body = (await sess.json()) as { data: { user: { email: string } | null } };
    expect(body.data.user?.email).toBe('a@example.com');
  });

  test('cookies are HttpOnly, scoped, and the refresh cookie is path-restricted', async () => {
    const { app } = buildApp();
    const up = await signUp(app);
    const raw = up.headers.getSetCookie?.() ?? [];
    const session = raw.find((c) => c.startsWith('flytrace_session=')) ?? '';
    const refresh = raw.find((c) => c.startsWith('flytrace_refresh=')) ?? '';

    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(refresh).toContain('HttpOnly');
    // Narrower scope: not attached to ordinary /api/v1 traffic.
    expect(refresh).toContain('Path=/api/auth');
  });

  test('no raw session token is ever persisted', async () => {
    const { app, repo } = buildApp();
    const up = await signUp(app);
    const raw = cookiesFrom(up).flytrace_session as string;

    expect(repo.storedTokenHashes).toHaveLength(1);
    expect(repo.storedTokenHashes[0]).toBe(hashToken(raw));
    expect(repo.storedTokenHashes).not.toContain(raw);
  });

  test('sign-in with a wrong password → 401', async () => {
    const { app } = buildApp();
    await signUp(app);
    const res = await signIn(app, 'a@example.com', 'nope');
    expect(res.status).toBe(401);
  });

  test('rejects a cross-origin (CSRF) POST', async () => {
    const { app } = buildApp();
    const res = await app.request('/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    expect(res.status).toBe(403);
  });

  test('sign-out revokes the session and clears both cookies', async () => {
    const { app } = buildApp();
    const up = await signUp(app);
    const cookie = cookieHeader(up);
    const out = await app.request('/sign-out', { method: 'POST', headers: { ...ORIGIN, cookie } });

    const cleared = out.headers.getSetCookie?.() ?? [];
    expect(cleared.some((c) => c.startsWith('flytrace_session='))).toBe(true);
    expect(cleared.some((c) => c.startsWith('flytrace_refresh='))).toBe(true);

    const sess = await app.request('/session', { headers: { cookie } });
    const body = (await sess.json()) as { data: { user: unknown } };
    expect(body.data.user).toBeNull();
  });

  test('rejects invalid sign-up payloads (422)', async () => {
    const { app } = buildApp();
    const res = await app.request('/sign-up', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
    });
    expect(res.status).toBe(422);
  });

  test('requires Turnstile on sign-up only when enabled', async () => {
    const { app } = buildApp({ turnstileEnabled: true });
    const missing = await signUp(app);
    expect(missing.status).toBe(403);

    const invalid = await app.request('/sign-up', {
      method: 'POST',
      headers: { ...ORIGIN, 'cf-turnstile-response': 'fail' },
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    expect(invalid.status).toBe(403);

    const ok = await app.request('/sign-up', {
      method: 'POST',
      headers: { ...ORIGIN, 'cf-turnstile-response': 'pass' },
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    expect(ok.status).toBe(201);
    expect((await signIn(app)).status).toBe(200);
  });
});

describe('auth routes — MFA login flow', () => {
  /** Sign up, then turn MFA on for the created user. */
  async function withMfaUser(harness: ReturnType<typeof buildApp>) {
    await signUp(harness.app);
    const user = await harness.repo.findUserByEmail('a@example.com');
    harness.mfa.enabledUsers.add(user?.id as string);
    return user?.id as string;
  }

  test('MFA disabled: sign-in returns a session directly', async () => {
    const { app } = buildApp();
    await signUp(app);
    const res = await signIn(app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('authenticated');
    expect(cookiesFrom(res).flytrace_session).toBeTruthy();
  });

  test('MFA enabled: sign-in returns mfa_required and creates NO session', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const sessionsBefore = harness.repo.sessionCount;

    const res = await signIn(harness.app);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { status: string; challengeToken: string; expiresInSeconds: number };
    };
    expect(body.data.status).toBe('mfa_required');
    expect(body.data.challengeToken).toMatch(/^[0-9a-f]{64}$/);
    expect(body.data.expiresInSeconds).toBe(300);

    // THE critical assertion: no cookie, no new session row.
    expect(cookiesFrom(res).flytrace_session).toBeUndefined();
    expect(cookiesFrom(res).flytrace_refresh).toBeUndefined();
    expect(harness.repo.sessionCount).toBe(sessionsBefore);
  });

  test('a correct TOTP completes the challenge and issues the session', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const before = harness.repo.sessionCount;
    const challenge = (await (await signIn(harness.app)).json()) as {
      data: { challengeToken: string };
    };

    const res = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: challenge.data.challengeToken, code: '123456' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe('authenticated');
    expect(cookiesFrom(res).flytrace_session).toBeTruthy();
    expect(harness.repo.sessionCount).toBe(before + 1);
  });

  test('a wrong TOTP is rejected without consuming the challenge', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const challenge = (await (await signIn(harness.app)).json()) as {
      data: { challengeToken: string };
    };
    const token = challenge.data.challengeToken;

    const bad = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '000000' }),
    });
    expect(bad.status).toBe(401);
    expect(harness.repo.sessionCount).toBe(1); // only the sign-up session

    // The same challenge still works with the right code.
    const good = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(good.status).toBe(200);
  });

  test('a challenge is single-use', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    const first = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(first.status).toBe(200);

    const replay = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(replay.status).toBe(401);
  });

  test('an expired challenge is rejected', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    harness.clock.advance(300_001);
    const res = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(res.status).toBe(401);
  });

  test('an unknown challenge token is rejected with the same message as an expired one', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const res = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: 'f'.repeat(64), code: '123456' }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('invalid or expired MFA challenge');
  });

  test('a backup code works once and is then dead', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    harness.mfa.backupCodes.add('BACKUP-1');

    const token1 = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;
    const ok = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token1, code: 'BACKUP-1' }),
    });
    expect(ok.status).toBe(200);

    const token2 = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;
    const reused = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token2, code: 'BACKUP-1' }),
    });
    expect(reused.status).toBe(401);
  });

  test('too many wrong codes burns the challenge', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    // maxAttempts = 3 in this harness.
    for (let i = 0; i < 3; i += 1) {
      const res = await harness.app.request('/mfa/verify', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ challengeToken: token, code: '000000' }),
      });
      expect(res.status).toBe(401);
    }
    const overLimit = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '000000' }),
    });
    expect(overLimit.status).toBe(429);

    // Even the correct code cannot revive a burned challenge.
    const after = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(after.status).toBe(401);
  });

  test('a challenge cannot be redeemed once MFA has been disabled', async () => {
    const harness = buildApp();
    const userId = await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    harness.mfa.enabledUsers.delete(userId);

    const res = await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });
    expect(res.status).toBe(401);
  });

  test('sign-in fails closed when the MFA lookup errors', async () => {
    const harness = buildApp();
    await signUp(harness.app);
    harness.mfa.isEnabledThrows = true;
    const before = harness.repo.sessionCount;

    const res = await signIn(harness.app);
    // A broken MFA store must NOT be read as "this user has no MFA".
    expect(res.status).toBe(500);
    expect(harness.repo.sessionCount).toBe(before);
  });

  test('successful and failed MFA attempts are audited', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '000000' }),
    });
    await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });

    const actions = (await harness.audit.list({})).map((e) => e.action);
    expect(actions).toContain('auth.mfa_challenge_issued');
    expect(actions).toContain('auth.mfa_failed');
    expect(actions).toContain('auth.mfa_verified');
    expect(actions).toContain('auth.signed_in');
  });

  test('audit records never contain the challenge token or the code', async () => {
    const harness = buildApp();
    await withMfaUser(harness);
    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;
    await harness.app.request('/mfa/verify', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ challengeToken: token, code: '123456' }),
    });

    const serialized = JSON.stringify(await harness.audit.list({}));
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('123456');
  });
});

describe('auth routes — rate limiting', () => {
  test('login is capped per identifier and returns Retry-After', async () => {
    const { app } = buildApp({
      rateLimitOverrides: { RATE_LIMIT_LOGIN_MAX: 2, RATE_LIMIT_LOGIN_WINDOW_MS: 60_000 },
    });
    await signUp(app);

    expect((await signIn(app, 'a@example.com', 'wrong')).status).toBe(401);
    expect((await signIn(app, 'a@example.com', 'wrong')).status).toBe(401);

    const limited = await signIn(app, 'a@example.com', 'wrong');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('RateLimit-Limit')).toBe('2');
    expect(limited.headers.get('RateLimit-Remaining')).toBe('0');
  });

  test('MFA verification is capped per challenge', async () => {
    const harness = buildApp({
      rateLimitOverrides: { RATE_LIMIT_MFA_VERIFY_MAX: 2, RATE_LIMIT_MFA_VERIFY_WINDOW_MS: 60_000 },
    });
    await signUp(harness.app);
    const user = await harness.repo.findUserByEmail('a@example.com');
    harness.mfa.enabledUsers.add(user?.id as string);

    const token = (
      (await (await signIn(harness.app)).json()) as { data: { challengeToken: string } }
    ).data.challengeToken;

    const attempt = () =>
      harness.app.request('/mfa/verify', {
        method: 'POST',
        headers: ORIGIN,
        body: JSON.stringify({ challengeToken: token, code: '000000' }),
      });

    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });
});
