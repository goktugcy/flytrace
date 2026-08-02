import { describe, expect, test } from 'bun:test';
import { AppError, createLogger, fixedClock, hashToken, isAppError } from '@flytrace/shared';
import { InMemoryAuditLog } from '../security/edge/audit-log.ts';
import { InMemoryMfaChallengeStore, MfaChallengeService } from '../security/mfa/challenge.ts';
import type { VerifyMethod } from '../security/mfa/mfa-service.ts';
import { DeviceService, createInMemoryDeviceRepo } from '../security/session/devices.ts';
import {
  RefreshTokenReuseError,
  RefreshTokenService,
  createInMemoryRefreshTokenRepo,
} from '../security/session/refresh-tokens.ts';
import { NoopSecurityNotifier } from '../security/session/security-notifier.ts';
import { AuthService, type Hasher } from './service.ts';
import { SignInFlow, type SignInFlowDeps } from './sign-in-flow.ts';
import { InMemoryAuthRepo } from './testing.ts';

const fakeHasher: Hasher = {
  hash: async (pw) => `h:${pw}`,
  verify: async (pw, h) => h === `h:${pw}`,
};

class FakeMfa {
  enabled = new Set<string>();
  async isEnabled(userId: string) {
    return this.enabled.has(userId);
  }
  async verify(_userId: string, code: string): Promise<VerifyMethod> {
    if (code !== '123456') throw new AppError('UNAUTHENTICATED', 'invalid MFA code');
    return 'totp';
  }
}

function make(
  opts: {
    reuseGraceMs?: number;
    ipPolicy?: 'prefix' | 'full' | 'none';
    challengeLimiter?: SignInFlowDeps['challengeLimiter'];
  } = {},
) {
  const clock = fixedClock(1_700_000_000_000);
  const repo = new InMemoryAuthRepo();
  repo.now = () => clock.now();
  const auth = new AuthService({ repo, clock, hasher: fakeHasher, sessionTtlMs: 60_000 });
  const mfa = new FakeMfa();
  const challenges = new MfaChallengeService({
    store: new InMemoryMfaChallengeStore(() => clock.now()),
    clock,
    ttlMs: 300_000,
    maxAttempts: 5,
  });
  const devices = new DeviceService({
    repo: createInMemoryDeviceRepo(),
    clock,
    ...(opts.ipPolicy ? { ipPolicy: opts.ipPolicy } : {}),
  });
  const refreshRepo = createInMemoryRefreshTokenRepo();
  const refreshTokens = new RefreshTokenService({
    repo: refreshRepo,
    clock,
    random: (() => {
      let n = 0;
      return () => `r${n++}`;
    })(),
    hasher: { hash: hashToken },
    ttlMs: 600_000,
    reuseGraceMs: opts.reuseGraceMs ?? 0,
  });
  const audit = new InMemoryAuditLog(clock);
  const notifier = new NoopSecurityNotifier();

  const flow = new SignInFlow({
    auth,
    mfa,
    challenges,
    devices,
    refreshTokens,
    audit,
    notifier,
    clock,
    logger: createLogger({ level: 'error' }),
    ...(opts.ipPolicy ? { ipPolicy: opts.ipPolicy } : {}),
    ...(opts.challengeLimiter ? { challengeLimiter: opts.challengeLimiter } : {}),
  });

  return { flow, auth, repo, mfa, refreshTokens, refreshRepo, audit, notifier, clock, devices };
}

const CTX = { ip: '203.0.113.7', userAgent: 'UA/1' };

async function newUser(h: ReturnType<typeof make>) {
  const { session } = await h.flow.signUp({
    email: 'a@example.com',
    password: 'hunter2!',
    ...CTX,
  });
  return session;
}

describe('SignInFlow — device registration', () => {
  test('sign-in registers a device and binds the session to it', async () => {
    const h = make();
    await newUser(h);
    const outcome = await h.flow.signIn({ email: 'a@example.com', password: 'hunter2!', ...CTX });

    expect(outcome.status).toBe('authenticated');
    if (outcome.status !== 'authenticated') return;
    expect(outcome.session.deviceId).toBeTruthy();

    const devices = await h.devices.listDevices(outcome.session.user.id);
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(outcome.session.deviceId);
  });

  test('a first sighting raises a new-device audit event and a notification', async () => {
    const h = make();
    await newUser(h);

    const actions = (await h.audit.list({})).map((e) => e.action);
    expect(actions).toContain('auth.new_device');
    expect(h.notifier.sent.map((n) => n.kind)).toContain('new_device');
  });

  test('a returning device is not reported as new', async () => {
    const h = make();
    await newUser(h);
    h.notifier.sent.length = 0;

    const outcome = await h.flow.signIn({ email: 'a@example.com', password: 'hunter2!', ...CTX });
    if (outcome.status !== 'authenticated') throw new Error('expected a session');
    expect(outcome.session.newDevice).toBe(false);
    expect(h.notifier.sent).toHaveLength(0);
  });

  test('sessions store the coarsened network, not the exact address', async () => {
    const h = make();
    await newUser(h);
    expect(h.repo.storedIps).toEqual(['203.0.113.0/24']);
  });

  test('SECURITY_IP_STORAGE=none persists no address at all', async () => {
    const h = make({ ipPolicy: 'none' });
    await newUser(h);
    expect(h.repo.storedIps).toEqual([null]);
  });

  test('a login from an unseen device and network scores as high risk', async () => {
    const h = make();
    await newUser(h);
    const outcome = await h.flow.signIn({
      email: 'a@example.com',
      password: 'hunter2!',
      ip: '198.51.100.9',
      userAgent: 'UA/2',
    });
    if (outcome.status !== 'authenticated') throw new Error('expected a session');
    expect(outcome.session.risk.risk).toBe('high');
    expect(outcome.session.risk.reasons).toContain('new_device');
    expect(outcome.session.risk.reasons).toContain('new_ip_prefix');
  });
});

describe('SignInFlow — refresh rotation', () => {
  test('a refresh rotates the token and mints a new session', async () => {
    const h = make();
    const first = await newUser(h);

    const refreshed = await h.flow.refresh(first.refreshToken, CTX);
    expect(refreshed.refreshToken).not.toBe(first.refreshToken);
    expect(refreshed.sessionToken).not.toBe(first.sessionToken);
    expect(refreshed.deviceId).toBe(first.deviceId);
    // The new session resolves; the old one is independent and also still valid
    // until it expires or is revoked.
    expect(await h.auth.session(refreshed.sessionToken)).not.toBeNull();
  });

  test('the old refresh token stops working after rotation', async () => {
    const h = make();
    const first = await newUser(h);
    await h.flow.refresh(first.refreshToken, CTX);

    const err = await h.flow.refresh(first.refreshToken, CTX).catch((e) => e);
    expect(isAppError(err)).toBe(true);
  });

  test('reuse revokes every refresh token AND every session, then notifies', async () => {
    const h = make();
    const first = await newUser(h);
    const second = await h.flow.refresh(first.refreshToken, CTX);
    expect(h.repo.sessionCount).toBeGreaterThan(0);

    const err = await h.flow.refresh(first.refreshToken, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(RefreshTokenReuseError);

    // Containment: nothing the attacker or the victim holds still works.
    expect(h.repo.sessionCount).toBe(0);
    await expect(h.flow.refresh(second.refreshToken, CTX)).rejects.toBeInstanceOf(AppError);

    const actions = (await h.audit.list({})).map((e) => e.action);
    expect(actions).toContain('auth.refresh_token_reuse_detected');
    expect(h.notifier.sent.map((n) => n.kind)).toContain('refresh_token_reuse');
  });

  test('the reuse notification carries no token material', async () => {
    const h = make();
    const first = await newUser(h);
    await h.flow.refresh(first.refreshToken, CTX);
    await h.flow.refresh(first.refreshToken, CTX).catch(() => {});

    const serialized = JSON.stringify(h.notifier.sent);
    expect(serialized).not.toContain(first.refreshToken);
    expect(serialized).not.toContain(first.sessionToken);
  });

  test('a parallel refresh does not fork the token family', async () => {
    const h = make();
    const first = await newUser(h);

    const results = await Promise.allSettled([
      h.flow.refresh(first.refreshToken, CTX),
      h.flow.refresh(first.refreshToken, CTX),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  test('within the grace window a duplicate refresh is rejected but not punished', async () => {
    const h = make({ reuseGraceMs: 10_000 });
    const first = await newUser(h);
    const second = await h.flow.refresh(first.refreshToken, CTX);

    h.clock.advance(1_000);
    const err = await h.flow.refresh(first.refreshToken, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).not.toBeInstanceOf(RefreshTokenReuseError);

    // The successor the client actually holds still works.
    await expect(h.flow.refresh(second.refreshToken, CTX)).resolves.toBeDefined();
  });
});

describe('SignInFlow — sign-out', () => {
  test('sign-out revokes the session and its refresh token', async () => {
    const h = make();
    const session = await newUser(h);

    await h.flow.signOut(session.sessionToken, session.refreshToken, CTX, session.user.id);
    expect(await h.auth.session(session.sessionToken)).toBeNull();
    await expect(h.flow.refresh(session.refreshToken, CTX)).rejects.toBeInstanceOf(AppError);
  });

  test('sign-out-all ends every session and refresh token for the user', async () => {
    const h = make();
    const a = await newUser(h);
    const b = await h.flow.signIn({
      email: 'a@example.com',
      password: 'hunter2!',
      ip: '198.51.100.1',
      userAgent: 'UA/2',
    });
    if (b.status !== 'authenticated') throw new Error('expected a session');

    await h.flow.signOutAllDevices(a.user.id, CTX);

    expect(h.repo.sessionCount).toBe(0);
    await expect(h.flow.refresh(a.refreshToken, CTX)).rejects.toBeInstanceOf(AppError);
    await expect(h.flow.refresh(b.session.refreshToken, CTX)).rejects.toBeInstanceOf(AppError);
    expect((await h.audit.list({})).map((e) => e.action)).toContain('auth.signed_out_all');
  });

  test('a password change invalidates every existing credential', async () => {
    const h = make();
    const session = await newUser(h);

    await h.flow.revokeAllAfterCredentialChange(session.user.id, 'password_changed', CTX);

    expect(await h.auth.session(session.sessionToken)).toBeNull();
    await expect(h.flow.refresh(session.refreshToken, CTX)).rejects.toBeInstanceOf(AppError);
    expect(h.notifier.sent.map((n) => n.kind)).toContain('password_changed');
    expect((await h.audit.list({})).map((e) => e.action)).toContain('auth.credentials_changed');
  });
});

describe('SignInFlow — audit hygiene', () => {
  test('audit rows carry the coarsened IP and never a token', async () => {
    const h = make();
    const session = await newUser(h);
    const entries = await h.audit.list({});

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(session.sessionToken);
    expect(serialized).not.toContain(session.refreshToken);
    expect(serialized).not.toContain('hunter2!');
    expect(serialized).not.toContain('203.0.113.7');
    expect(entries.some((e) => e.ip === '203.0.113.0/24')).toBe(true);
  });
});

describe('SignInFlow — MFA challenge issuance limit', () => {
  /** Wires the mfaChallenge guard onto an MFA-enabled account. */
  function withGuard(opts: { max?: number; throws?: boolean } = {}) {
    const max = opts.max ?? 2;
    let calls = 0;
    return make({
      challengeLimiter: {
        max,
        windowMs: 300_000,
        limiter: {
          async check() {
            if (opts.throws) throw new Error('redis down');
            calls += 1;
            return { allowed: calls <= max };
          },
        },
      },
    });
  }

  async function enableMfa(h: ReturnType<typeof make>) {
    await newUser(h);
    const user = await h.repo.findUserByEmail('a@example.com');
    h.mfa.enabled.add(user?.id as string);
  }

  test('caps how many challenges one account can mint', async () => {
    const h = withGuard({ max: 2 });
    await enableMfa(h);
    const attempt = () => h.flow.signIn({ email: 'a@example.com', password: 'hunter2!', ...CTX });

    expect((await attempt()).status).toBe('mfa_required');
    expect((await attempt()).status).toBe('mfa_required');

    const limited = await attempt().catch((e) => e);
    expect(isAppError(limited) && limited.code).toBe('RATE_LIMITED');
    expect((await h.audit.list({})).map((e) => e.action)).toContain('auth.mfa_challenge_throttled');
  });

  test('fails closed when the limiter backend is unavailable', async () => {
    const h = withGuard({ throws: true });
    await enableMfa(h);
    const err = await h.flow
      .signIn({ email: 'a@example.com', password: 'hunter2!', ...CTX })
      .catch((e) => e);
    // No challenge is minted and no session is issued.
    expect(isAppError(err) && err.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  test('does not apply to accounts without MFA', async () => {
    const h = withGuard({ max: 0 });
    await newUser(h); // MFA not enabled
    const outcome = await h.flow.signIn({
      email: 'a@example.com',
      password: 'hunter2!',
      ...CTX,
    });
    expect(outcome.status).toBe('authenticated');
  });
});
