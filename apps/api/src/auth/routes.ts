import { AppError } from '@flytrace/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { PolicyMiddlewareDeps } from '../security/edge/rate-limit-policies.ts';
import { identifierRateLimit, ipRateLimit } from '../security/edge/rate-limit-policies.ts';
import { type TurnstileVerifier, turnstileMiddleware } from '../security/edge/turnstile.ts';
import { extractClientIp } from '../security/session/ip.ts';
import {
  type CookieOptions,
  clearRefreshCookie,
  clearSessionCookie,
  getRefreshToken,
  getSessionToken,
  setRefreshCookie,
  setSessionCookie,
} from './cookie.ts';
import type { AuthService } from './service.ts';
import type { AuthenticatedSession, SignInFlow } from './sign-in-flow.ts';

const signUpSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(8).max(200),
});
const signInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
/**
 * The challenge token is a 64-char hex digest and the code is a 6-digit TOTP or
 * a backup code; both are bounded so an oversized body cannot be used to burn
 * CPU in the verifier.
 */
const mfaVerifySchema = z.object({
  challengeToken: z.string().min(16).max(256),
  code: z.string().min(4).max(64),
});

/**
 * Populates `c.var.user` from the session cookie for every request (best-effort;
 * never throws). Downstream guards/handlers decide what to do when it's null.
 */
export function attachSession(service: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getSessionToken(c);
    const session = await service.session(token);
    c.set('user', session?.user ?? null);
    c.set('sessionToken', token);
    await next();
  };
}

/** Require an authenticated session; 401 otherwise. For owner-scoped routes. */
export function requireUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('user')) throw new AppError('UNAUTHENTICATED', 'sign in required');
    await next();
  };
}

/** Require an authenticated session with a specific role (admin console). */
export function requireRole(role: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    if (user.role !== role) throw new AppError('FORBIDDEN', 'insufficient role');
    await next();
  };
}

/** Reject state-changing requests whose Origin is present but not allow-listed. */
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

export interface AuthRoutesOptions {
  allowedOrigins: string[];
  cookies: CookieOptions;
  rateLimit: PolicyMiddlewareDeps;
  turnstile?: {
    verifier: TurnstileVerifier;
    enabled: boolean;
    failOpen: boolean;
    expectedAction: string;
    expectedHostname?: string | undefined;
  };
}

/** Request origin, from the trusted proxy headers. */
function requestContext(c: {
  req: { header(name: string): string | undefined };
}): { ip: string | null; userAgent: string | null } {
  const cf = c.req.header('cf-connecting-ip');
  const ip =
    cf?.trim() ||
    extractClientIp({
      get: (name: string) => c.req.header(name) ?? null,
    });
  return { ip: ip || null, userAgent: c.req.header('user-agent') ?? null };
}

/**
 * Credentials routes under /api/auth (docs/11 §11.6).
 *
 * The contract callers must understand: `POST /sign-in` answers with EITHER a
 * session (cookies set, `status: "authenticated"`) OR a challenge (`status:
 * "mfa_required"`, no cookies). It never sets a session cookie for an account
 * with MFA enabled.
 */
export function createAuthRoutes(flow: SignInFlow, opts: AuthRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', csrfGuard(opts.allowedOrigins));

  const turnstileForSignUp = opts.turnstile
    ? turnstileMiddleware(opts.turnstile.verifier, {
        enabled: opts.turnstile.enabled,
        failOpen: opts.turnstile.failOpen,
        expectedAction: opts.turnstile.expectedAction,
        expectedHostname: opts.turnstile.expectedHostname,
      })
    : undefined;

  /** Read the email from the body for per-account rate limiting. */
  const emailFromBody = async (c: {
    req: { json(): Promise<unknown> };
  }): Promise<string | null> => {
    const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
    return typeof body?.email === 'string' ? body.email.trim().toLowerCase() : null;
  };

  /** Set both cookies for a completed authentication. */
  const applySession = (
    c: Parameters<MiddlewareHandler<AppEnv>>[0],
    session: AuthenticatedSession,
  ): void => {
    setSessionCookie(c, session.sessionToken, session.sessionExpiresAt, opts.cookies);
    setRefreshCookie(c, session.refreshToken, session.refreshExpiresAt, opts.cookies);
  };

  /**
   * The public shape of an authenticated response. Note what is absent: the
   * session and refresh tokens live in HttpOnly cookies only — putting them in
   * the JSON body would hand them to any script on the page.
   */
  const sessionPayload = (session: AuthenticatedSession) => ({
    status: 'authenticated' as const,
    user: session.user,
    expiresAt: session.sessionExpiresAt.toISOString(),
    newDevice: session.newDevice,
  });

  // ── sign-up ────────────────────────────────────────────────────────────────
  const signUpHandler: MiddlewareHandler<AppEnv> = async (c) => {
    const parsed = signUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid sign-up', { details: parsed.error.issues });
    const ctx = requestContext(c);
    const { session } = await flow.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name ?? null,
      ...ctx,
    });
    applySession(c, session);
    return c.json({ data: sessionPayload(session), meta: { requestId: c.get('requestId') } }, 201);
  };

  const signUpLimit = identifierRateLimit(opts.rateLimit, 'signup', emailFromBody);
  if (turnstileForSignUp) app.post('/sign-up', signUpLimit, turnstileForSignUp, signUpHandler);
  else app.post('/sign-up', signUpLimit, signUpHandler);

  // ── sign-in (step 1) ───────────────────────────────────────────────────────
  app.post('/sign-in', identifierRateLimit(opts.rateLimit, 'login', emailFromBody), async (c) => {
    const parsed = signInSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid sign-in', { details: parsed.error.issues });

    const outcome = await flow.signIn({
      email: parsed.data.email,
      password: parsed.data.password,
      ...requestContext(c),
    });

    if (outcome.status === 'mfa_required') {
      // No cookies are set here. The challenge token is returned in the body
      // because the client must hold it only for the length of the second
      // step — see apps/web AuthForm, which keeps it in component state.
      return c.json({
        data: {
          status: 'mfa_required' as const,
          challengeToken: outcome.challengeToken,
          expiresAt: outcome.challengeExpiresAt.toISOString(),
          expiresInSeconds: outcome.expiresInSeconds,
        },
        meta: { requestId: c.get('requestId') },
      });
    }

    applySession(c, outcome.session);
    return c.json({
      data: sessionPayload(outcome.session),
      meta: { requestId: c.get('requestId') },
    });
  });

  // ── sign-in (step 2): redeem the MFA challenge ─────────────────────────────
  app.post(
    '/mfa/verify',
    identifierRateLimit(opts.rateLimit, 'mfaVerify', async (c) => {
      // Bucket by challenge, so guessing codes against ONE challenge is capped
      // independently of the per-IP budget.
      const body = (await c.req.json().catch(() => null)) as { challengeToken?: unknown } | null;
      return typeof body?.challengeToken === 'string' ? body.challengeToken : null;
    }),
    async (c) => {
      const parsed = mfaVerifySchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        throw new AppError('VALIDATION_ERROR', 'invalid MFA verification', {
          details: parsed.error.issues,
        });

      const session = await flow.completeMfa({
        challengeToken: parsed.data.challengeToken,
        code: parsed.data.code,
        ...requestContext(c),
      });
      applySession(c, session);
      return c.json({ data: sessionPayload(session), meta: { requestId: c.get('requestId') } });
    },
  );

  // ── refresh ────────────────────────────────────────────────────────────────
  app.post('/refresh', ipRateLimit(opts.rateLimit, 'refresh'), async (c) => {
    const token = getRefreshToken(c);
    if (!token) {
      // Identical error to an invalid token: a caller learns nothing about
      // whether a cookie was present, valid, expired, or already rotated.
      throw new AppError('UNAUTHENTICATED', 'invalid refresh token');
    }
    try {
      const session = await flow.refresh(token, requestContext(c));
      applySession(c, session);
      return c.json({ data: sessionPayload(session), meta: { requestId: c.get('requestId') } });
    } catch (err) {
      // Any refresh failure clears both cookies so the browser stops replaying
      // a dead credential on every subsequent attempt.
      clearRefreshCookie(c, opts.cookies);
      clearSessionCookie(c, opts.cookies);
      throw err;
    }
  });

  // ── sign-out ───────────────────────────────────────────────────────────────
  app.post('/sign-out', async (c) => {
    const user = c.get('user');
    await flow.signOut(getSessionToken(c), getRefreshToken(c), requestContext(c), user?.id);
    clearSessionCookie(c, opts.cookies);
    clearRefreshCookie(c, opts.cookies);
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/sign-out-all', requireUser(), async (c) => {
    const user = c.get('user');
    if (!user) throw new AppError('UNAUTHENTICATED', 'sign in required');
    await flow.signOutAllDevices(user.id, requestContext(c));
    clearSessionCookie(c, opts.cookies);
    clearRefreshCookie(c, opts.cookies);
    return c.json({ data: { ok: true }, meta: { requestId: c.get('requestId') } });
  });

  app.get('/session', (c) => {
    return c.json({
      data: { user: c.get('user') ?? null },
      meta: { requestId: c.get('requestId') },
    });
  });

  return app;
}
