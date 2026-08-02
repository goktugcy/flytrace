/**
 * The single post-authentication pipeline (docs/15 §15.1, §7b).
 *
 * Everything that must happen when a principal becomes authenticated lives
 * here — device registration, risk assessment, session creation, refresh-token
 * issuance, audit, notification — so that sign-up, password sign-in, MFA
 * completion and refresh all converge on ONE implementation. Route handlers stay
 * thin and cannot accidentally skip a step.
 *
 * The security-critical property this file exists to enforce: with MFA enabled,
 * a correct password produces a CHALLENGE, never a session. `AuthService`
 * cannot mint a session as a side effect of verifying credentials, and the only
 * paths that call `startSession` are the ones below.
 */
import type { AuthUser } from '@flytrace/db';
import { AppError, type Clock, type Logger, hashKeyComponent } from '@flytrace/shared';
import type { AuditLog } from '../security/edge/audit-log.ts';
import type { MfaChallengeService } from '../security/mfa/challenge.ts';
import type { MfaService, VerifyMethod } from '../security/mfa/mfa-service.ts';
import type { DeviceService } from '../security/session/devices.ts';
import { type IpStoragePolicy, applyIpPolicy } from '../security/session/ip.ts';
import {
  RefreshTokenReuseError,
  type RefreshTokenService,
} from '../security/session/refresh-tokens.ts';
import type { SecurityNotifier } from '../security/session/security-notifier.ts';
import { type LoginAssessment, assessLogin } from '../security/session/suspicious-login.ts';
import type { AuthService } from './service.ts';

type MfaPort = Pick<MfaService, 'isEnabled' | 'verify'>;
type DevicePort = Pick<DeviceService, 'register' | 'listDevices'>;
type RefreshPort = Pick<
  RefreshTokenService,
  'issue' | 'rotate' | 'revoke' | 'revokeAllForUser' | 'revokeAllForDevice'
>;
type AuthPort = Pick<
  AuthService,
  | 'signUp'
  | 'verifyCredentials'
  | 'startSession'
  | 'findUser'
  | 'signOut'
  | 'signOutAll'
  | 'signOutDevice'
>;

/** Everything a request contributes about its origin. */
export interface RequestContext {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Bounds how many MFA challenges one account may mint.
 *
 * This cannot live in route middleware: whether a challenge gets issued is only
 * known *after* the password is verified. Without it, an attacker holding one
 * valid password could mint challenges indefinitely — each one a Redis write —
 * while still failing the second factor. Enforced per user id, so it does not
 * punish a shared NAT.
 */
export interface ChallengeIssueLimiter {
  check(key: string, limit: number, windowMs: number): Promise<{ allowed: boolean }>;
}

export interface SignInFlowDeps {
  auth: AuthPort;
  mfa: MfaPort;
  challenges: MfaChallengeService;
  devices: DevicePort;
  refreshTokens: RefreshPort;
  audit: AuditLog;
  notifier: SecurityNotifier;
  clock: Clock;
  logger: Logger;
  /** What may be persisted as a session/audit IP. Defaults to the prefix. */
  ipPolicy?: IpStoragePolicy | undefined;
  impossibleTravelMaxKmh?: number | undefined;
  /** Applies the `mfaChallenge` policy to challenge issuance. */
  challengeLimiter?: { limiter: ChallengeIssueLimiter; max: number; windowMs: number } | undefined;
}

/** A fully-authenticated result: a session cookie plus a refresh credential. */
export interface AuthenticatedSession {
  user: AuthUser;
  sessionToken: string;
  sessionExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  deviceId: string;
  newDevice: boolean;
  risk: LoginAssessment;
}

/** Sign-in either completes, or stops at the second factor. */
export type SignInOutcome =
  | { status: 'authenticated'; session: AuthenticatedSession }
  | {
      status: 'mfa_required';
      challengeToken: string;
      challengeExpiresAt: Date;
      expiresInSeconds: number;
    };

export interface SignInInput extends RequestContext {
  email: string;
  password: string;
}

export interface CompleteMfaInput extends RequestContext {
  challengeToken: string;
  code: string;
}

export class SignInFlow {
  constructor(private readonly deps: SignInFlowDeps) {}

  private storableIp(ip: string | null): string | null {
    return applyIpPolicy(ip, this.deps.ipPolicy ?? 'prefix');
  }

  /** Audit helper — records the coarsened IP only, never headers or tokens. */
  private async record(
    action: string,
    actorId: string | undefined,
    ctx: RequestContext,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.audit.record({
        ...(actorId ? { actorId, target: `user:${actorId}` } : {}),
        action,
        ...(this.storableIp(ctx.ip) ? { ip: this.storableIp(ctx.ip) as string } : {}),
        ...(meta ? { meta } : {}),
      });
    } catch (err) {
      // An audit outage must not break authentication, but it must be loud.
      this.deps.logger.error('audit write failed', { action, err: String(err) });
    }
  }

  /**
   * Step 1 of sign-in: prove the password, then branch on MFA.
   *
   * If MFA is enabled the caller gets a challenge and NO session — this is the
   * whole point of the flow. If the MFA lookup itself fails we fail closed
   * (the error propagates) rather than assuming "no MFA" and handing out a
   * session, which would turn a database blip into an MFA bypass.
   */
  async signIn(input: SignInInput): Promise<SignInOutcome> {
    const { user } = await this.deps.auth.verifyCredentials({
      email: input.email,
      password: input.password,
    });

    const mfaEnabled = await this.deps.mfa.isEnabled(user.id);
    if (mfaEnabled) {
      await this.guardChallengeIssuance(user.id, input);
      const challenge = await this.deps.challenges.issue(user.id);
      await this.record('auth.mfa_challenge_issued', user.id, input);
      return {
        status: 'mfa_required',
        challengeToken: challenge.token,
        challengeExpiresAt: challenge.expiresAt,
        expiresInSeconds: challenge.expiresInSeconds,
      };
    }

    const session = await this.issueSession(user, input, { mfa: false });
    await this.record('auth.signed_in', user.id, input, {
      method: 'password',
      mfa: false,
      deviceId: session.deviceId,
      newDevice: session.newDevice,
      risk: session.risk.risk,
      riskReasons: session.risk.reasons,
    });
    return { status: 'authenticated', session };
  }

  /**
   * Enforce the `mfaChallenge` policy before minting a challenge.
   *
   * Fails CLOSED: if the shared counter is unreachable we refuse to issue,
   * matching the policy's declared posture. Refusing costs a legitimate user
   * one retry; the alternative is an unbounded challenge mint on a credential
   * endpoint.
   */
  private async guardChallengeIssuance(userId: string, ctx: RequestContext): Promise<void> {
    const guard = this.deps.challengeLimiter;
    if (!guard) return;
    const key = `mfaChallenge:${hashKeyComponent(userId)}`;
    let allowed: boolean;
    try {
      ({ allowed } = await guard.limiter.check(key, guard.max, guard.windowMs));
    } catch (err) {
      this.deps.logger.warn('mfa challenge limiter unavailable — failing closed', {
        err: String(err),
      });
      throw new AppError('UPSTREAM_UNAVAILABLE', 'rate limiting is unavailable');
    }
    if (!allowed) {
      await this.record('auth.mfa_challenge_throttled', userId, ctx);
      throw new AppError('RATE_LIMITED', 'too many sign-in attempts');
    }
  }

  /** Sign-up: no second factor can exist yet, so it issues a session directly. */
  async signUp(
    input: SignInInput & { name?: string | null },
  ): Promise<{ session: AuthenticatedSession }> {
    const user = await this.deps.auth.signUp({
      email: input.email,
      password: input.password,
      name: input.name ?? null,
    });
    const session = await this.issueSession(user, input, { mfa: false });
    await this.record('auth.signed_up', user.id, input, { deviceId: session.deviceId });
    return { session };
  }

  /**
   * Step 2 of sign-in: redeem the challenge with a TOTP token or backup code.
   *
   * Ordering matters. The challenge is validated (exists, unexpired, under the
   * attempt cap, not concurrently held) BEFORE the code is checked, and it is
   * consumed only after the code verifies. A wrong code therefore costs an
   * attempt but keeps the challenge usable, while a correct code can be spent
   * exactly once.
   */
  async completeMfa(input: CompleteMfaInput): Promise<AuthenticatedSession> {
    let verifiedUserId: string | undefined;
    try {
      const completion = await this.deps.challenges.complete<{
        method: VerifyMethod;
        user: AuthUser;
      }>(input.challengeToken, async (userId) => {
        verifiedUserId = userId;
        // MFA may have been disabled between issuing and redeeming the
        // challenge. An open challenge must not outlive the requirement it
        // represents, so refuse rather than silently accept anything.
        if (!(await this.deps.mfa.isEnabled(userId))) {
          throw new AppError('UNAUTHENTICATED', 'invalid or expired MFA challenge');
        }
        const method = await this.deps.mfa.verify(userId, input.code);
        const user = await this.deps.auth.findUser(userId);
        if (!user) throw new AppError('UNAUTHENTICATED', 'invalid or expired MFA challenge');
        return { method, user };
      });

      const { user, method } = completion.result;
      const session = await this.issueSession(user, input, { mfa: true });
      await this.record('auth.mfa_verified', user.id, input, { method });
      await this.record('auth.signed_in', user.id, input, {
        method: 'password+mfa',
        mfa: true,
        mfaMethod: method,
        deviceId: session.deviceId,
        newDevice: session.newDevice,
        risk: session.risk.risk,
        riskReasons: session.risk.reasons,
      });
      return session;
    } catch (err) {
      await this.record('auth.mfa_failed', verifiedUserId, input, {
        reason: err instanceof AppError ? err.code : 'INTERNAL',
      });
      throw err;
    }
  }

  /**
   * Exchange a refresh token for a fresh session + rotated refresh token.
   *
   * On detected reuse the blast radius is contained here: the family is already
   * revoked by the service, and this additionally kills the user's other
   * refresh tokens and every active session, writes an audit record and sends
   * an out-of-band notification. A leaked token buys the attacker nothing and
   * the legitimate user is told.
   */
  async refresh(refreshToken: string, ctx: RequestContext): Promise<AuthenticatedSession> {
    try {
      const rotated = await this.deps.refreshTokens.rotate(refreshToken);
      const user = await this.deps.auth.findUser(rotated.userId);
      if (!user) throw new AppError('UNAUTHENTICATED', 'invalid refresh token');

      const session = await this.deps.auth.startSession({
        user,
        ip: this.storableIp(ctx.ip),
        userAgent: ctx.userAgent,
        deviceId: rotated.deviceId,
      });

      await this.record('auth.session_refreshed', user.id, ctx, {
        deviceId: rotated.deviceId,
      });

      return {
        user,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt,
        refreshToken: rotated.token,
        refreshExpiresAt: rotated.expiresAt,
        deviceId: rotated.deviceId,
        newDevice: false,
        risk: { risk: 'low', reasons: [] },
      };
    } catch (err) {
      if (err instanceof RefreshTokenReuseError) {
        await this.containReuse(err, ctx);
      }
      throw err;
    }
  }

  /** Full containment for a confirmed refresh-token replay. */
  private async containReuse(err: RefreshTokenReuseError, ctx: RequestContext): Promise<void> {
    try {
      await this.deps.refreshTokens.revokeAllForUser(err.userId);
      await this.deps.auth.signOutAll(err.userId);
    } catch (revokeErr) {
      this.deps.logger.error('refresh reuse containment failed', {
        userId: err.userId,
        err: String(revokeErr),
      });
    }
    await this.record('auth.refresh_token_reuse_detected', err.userId, ctx, {
      familyId: err.familyId,
      deviceId: err.deviceId,
      action: 'revoked_all_sessions_and_refresh_tokens',
    });
    await this.deps.notifier
      .notify({
        userId: err.userId,
        kind: 'refresh_token_reuse',
        title: 'Security alert: your session was signed out',
        body:
          'We detected a sign-in credential being reused, which can mean it was copied. ' +
          'All sessions and devices have been signed out as a precaution. ' +
          'Please sign in again and change your password if you did not expect this.',
        url: '/settings/notifications',
      })
      .catch((notifyErr) =>
        this.deps.logger.warn('reuse notification failed', { err: String(notifyErr) }),
      );
  }

  /** Sign out of the current session and revoke its refresh token. */
  async signOut(
    sessionToken: string | undefined,
    refreshToken: string | undefined,
    ctx: RequestContext,
    userId?: string,
  ): Promise<void> {
    await this.deps.auth.signOut(sessionToken);
    if (refreshToken) await this.deps.refreshTokens.revoke(refreshToken);
    await this.record('auth.signed_out', userId, ctx);
  }

  /** Sign out everywhere: every session and every refresh token for the user. */
  async signOutAllDevices(userId: string, ctx: RequestContext): Promise<void> {
    await this.deps.refreshTokens.revokeAllForUser(userId);
    const sessions = await this.deps.auth.signOutAll(userId);
    await this.record('auth.signed_out_all', userId, ctx, { sessionsRevoked: sessions });
  }

  /**
   * Invalidate every credential after a security-relevant account change.
   *
   * Applied on password change and on MFA reset/disable. The reasoning: both
   * events mean "the set of people who can authenticate as this account just
   * changed", so any session that predates the change may belong to whoever was
   * being locked out. Keeping them alive would make a password change useless
   * against an attacker who already holds a session cookie.
   */
  async revokeAllAfterCredentialChange(
    userId: string,
    reason: 'password_changed' | 'mfa_disabled' | 'mfa_enabled',
    ctx: RequestContext,
    opts: { notify?: boolean } = {},
  ): Promise<void> {
    await this.deps.refreshTokens.revokeAllForUser(userId);
    const sessions = await this.deps.auth.signOutAll(userId);
    await this.record('auth.credentials_changed', userId, ctx, { reason, sessions });
    if (opts.notify !== false) {
      await this.deps.notifier
        .notify({
          userId,
          kind: reason,
          title: 'Your FlyTrace security settings changed',
          body:
            reason === 'password_changed'
              ? 'Your password was changed and all other sessions were signed out. If this was not you, reset your password immediately.'
              : 'Your two-factor settings changed and all sessions were signed out. If this was not you, secure your account immediately.',
          url: '/settings/notifications',
        })
        .catch((err) =>
          this.deps.logger.warn('credential-change notify failed', { err: String(err) }),
        );
    }
  }

  /**
   * The shared tail of every successful authentication: register the device,
   * score the login, mint the session and the refresh token, and alert on a
   * first sighting.
   */
  private async issueSession(
    user: AuthUser,
    ctx: RequestContext,
    meta: { mfa: boolean },
  ): Promise<AuthenticatedSession> {
    const known = await this.deps.devices.listDevices(user.id);
    const registered = await this.deps.devices.register(user.id, {
      ua: ctx.userAgent,
      ip: ctx.ip,
    });

    const risk = this.assess(registered.fingerprint, ctx.ip, known);

    const session = await this.deps.auth.startSession({
      user,
      ip: this.storableIp(ctx.ip),
      userAgent: ctx.userAgent,
      deviceId: registered.deviceId,
    });
    const refresh = await this.deps.refreshTokens.issue(user.id, registered.deviceId);

    if (registered.isNew) {
      await this.record('auth.new_device', user.id, ctx, {
        deviceId: registered.deviceId,
        mfa: meta.mfa,
        risk: risk.risk,
      });
      await this.deps.notifier
        .notify({
          userId: user.id,
          kind: 'new_device',
          title: 'New sign-in to your FlyTrace account',
          body:
            'Your account was just accessed from a device we have not seen before. ' +
            'If this was you, no action is needed. If not, sign out all devices and change your password.',
          url: '/settings/notifications',
        })
        .catch((err) => this.deps.logger.warn('new-device notify failed', { err: String(err) }));
    }

    return {
      user,
      sessionToken: session.token,
      sessionExpiresAt: session.expiresAt,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      deviceId: registered.deviceId,
      newDevice: registered.isNew,
      risk,
    };
  }

  /** Score the login against previously-seen devices/networks. Pure. */
  private assess(
    fingerprint: string,
    ip: string | null,
    known: Array<{ fingerprint: string; lastIp: string | null }>,
  ): LoginAssessment {
    const knownFingerprints = known.map((d) => d.fingerprint);
    if (!ip) {
      // Without an address we can only judge the device.
      return assessLogin({
        fingerprint,
        knownFingerprints,
        ip: '0.0.0.0',
        knownIps: ['0.0.0.0'],
      });
    }
    return assessLogin({
      fingerprint,
      knownFingerprints,
      ip,
      knownIps: known.map((d) => d.lastIp).filter((v): v is string => Boolean(v)),
    });
  }
}
