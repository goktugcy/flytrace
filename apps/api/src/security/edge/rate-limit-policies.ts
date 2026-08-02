/**
 * Named rate-limit policies (docs §7c).
 *
 * One place that answers "how many, how often, and what happens when the
 * limiter itself is down" for every sensitive surface. Route modules ask for a
 * policy by name; they never invent their own numbers and never construct their
 * own limiter — which is what previously let the security routes run a private
 * in-memory counter that no other instance could see.
 *
 * Failure posture is per-policy and deliberate:
 *   - credential endpoints are **fail-closed**: if the shared counter is
 *     unavailable we cannot bound online guessing, so we stop rather than serve
 *     unlimited login attempts.
 *   - read/ops endpoints are **fail-open**: a Redis blip should not black out
 *     the product or the monitoring path.
 */
import { AppError, type MinimalLogger } from '@flytrace/shared';
import type { Context, MiddlewareHandler } from 'hono';
import {
  type RateLimitResult,
  type RateLimiter,
  rateLimitKey,
  rateLimitMiddleware,
} from './rate-limit.ts';

export type RateLimitPolicyName =
  | 'api'
  | 'login'
  | 'signup'
  | 'mfaChallenge'
  | 'mfaVerify'
  | 'refresh'
  | 'passwordReset'
  | 'wsTicket'
  | 'security'
  | 'admin'
  | 'ops'
  | 'cspReport';

export interface RateLimitPolicy {
  max: number;
  windowMs: number;
  onError: 'fail-open' | 'fail-closed';
}

export type RateLimitPolicies = Record<RateLimitPolicyName, RateLimitPolicy>;

/** The config slice these policies are built from. */
export interface RateLimitPolicyConfig {
  RATE_LIMIT_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_LOGIN_MAX: number;
  RATE_LIMIT_LOGIN_WINDOW_MS: number;
  RATE_LIMIT_SIGNUP_MAX: number;
  RATE_LIMIT_SIGNUP_WINDOW_MS: number;
  RATE_LIMIT_MFA_CHALLENGE_MAX: number;
  RATE_LIMIT_MFA_CHALLENGE_WINDOW_MS: number;
  RATE_LIMIT_MFA_VERIFY_MAX: number;
  RATE_LIMIT_MFA_VERIFY_WINDOW_MS: number;
  RATE_LIMIT_REFRESH_MAX: number;
  RATE_LIMIT_REFRESH_WINDOW_MS: number;
  RATE_LIMIT_PASSWORD_RESET_MAX: number;
  RATE_LIMIT_PASSWORD_RESET_WINDOW_MS: number;
  RATE_LIMIT_WS_TICKET_MAX: number;
  RATE_LIMIT_WS_TICKET_WINDOW_MS: number;
  RATE_LIMIT_SECURITY_MAX: number;
  RATE_LIMIT_SECURITY_WINDOW_MS: number;
  RATE_LIMIT_ADMIN_MAX: number;
  RATE_LIMIT_ADMIN_WINDOW_MS: number;
  RATE_LIMIT_OPS_MAX: number;
  RATE_LIMIT_OPS_WINDOW_MS: number;
}

export function buildRateLimitPolicies(cfg: RateLimitPolicyConfig): RateLimitPolicies {
  return {
    api: {
      max: cfg.RATE_LIMIT_MAX,
      windowMs: cfg.RATE_LIMIT_WINDOW_MS,
      onError: 'fail-open',
    },
    login: {
      max: cfg.RATE_LIMIT_LOGIN_MAX,
      windowMs: cfg.RATE_LIMIT_LOGIN_WINDOW_MS,
      onError: 'fail-closed',
    },
    signup: {
      max: cfg.RATE_LIMIT_SIGNUP_MAX,
      windowMs: cfg.RATE_LIMIT_SIGNUP_WINDOW_MS,
      onError: 'fail-closed',
    },
    mfaChallenge: {
      max: cfg.RATE_LIMIT_MFA_CHALLENGE_MAX,
      windowMs: cfg.RATE_LIMIT_MFA_CHALLENGE_WINDOW_MS,
      onError: 'fail-closed',
    },
    mfaVerify: {
      max: cfg.RATE_LIMIT_MFA_VERIFY_MAX,
      windowMs: cfg.RATE_LIMIT_MFA_VERIFY_WINDOW_MS,
      onError: 'fail-closed',
    },
    refresh: {
      max: cfg.RATE_LIMIT_REFRESH_MAX,
      windowMs: cfg.RATE_LIMIT_REFRESH_WINDOW_MS,
      onError: 'fail-closed',
    },
    passwordReset: {
      max: cfg.RATE_LIMIT_PASSWORD_RESET_MAX,
      windowMs: cfg.RATE_LIMIT_PASSWORD_RESET_WINDOW_MS,
      onError: 'fail-closed',
    },
    wsTicket: {
      max: cfg.RATE_LIMIT_WS_TICKET_MAX,
      windowMs: cfg.RATE_LIMIT_WS_TICKET_WINDOW_MS,
      onError: 'fail-closed',
    },
    security: {
      max: cfg.RATE_LIMIT_SECURITY_MAX,
      windowMs: cfg.RATE_LIMIT_SECURITY_WINDOW_MS,
      onError: 'fail-closed',
    },
    admin: {
      max: cfg.RATE_LIMIT_ADMIN_MAX,
      windowMs: cfg.RATE_LIMIT_ADMIN_WINDOW_MS,
      onError: 'fail-closed',
    },
    ops: {
      max: cfg.RATE_LIMIT_OPS_MAX,
      windowMs: cfg.RATE_LIMIT_OPS_WINDOW_MS,
      // Monitoring must keep answering even if Redis is the thing that broke.
      onError: 'fail-open',
    },
    cspReport: {
      max: cfg.RATE_LIMIT_MAX,
      windowMs: cfg.RATE_LIMIT_WINDOW_MS,
      onError: 'fail-open',
    },
  };
}

/**
 * Trusted client address.
 *
 * `cf-connecting-ip` is set by Cloudflare and `x-forwarded-for` by the reverse
 * proxy; both are attacker-controlled if the app is exposed directly, which is
 * why the deployment docs require the proxy to OVERWRITE (not append) these
 * headers. We take the LEFT-most `x-forwarded-for` entry, matching the
 * proxy-writes-the-real-client convention documented in
 * `deploy/nginx/flytrace.conf`.
 */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf?.trim()) return cf.trim();
  const xff = c.req.header('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  if (first) return first;
  return c.req.header('x-real-ip')?.trim() || 'unknown';
}

export interface PolicyMiddlewareDeps {
  limiter: RateLimiter;
  policies: RateLimitPolicies;
  logger?: Pick<MinimalLogger, 'warn'> | undefined;
}

/** Build a middleware for a named policy, keyed by a caller-supplied selector. */
export function policyRateLimit(
  deps: PolicyMiddlewareDeps,
  name: RateLimitPolicyName,
  keyParts: (c: Context) => Array<string | null | undefined>,
) {
  const policy = deps.policies[name];
  return rateLimitMiddleware({
    limiter: deps.limiter,
    max: policy.max,
    windowMs: policy.windowMs,
    onError: policy.onError,
    ...(deps.logger ? { logger: deps.logger } : {}),
    keyFn: (c) => rateLimitKey(name, ...keyParts(c)),
  });
}

/** Per-IP policy — the default for unauthenticated surfaces. */
export function ipRateLimit(deps: PolicyMiddlewareDeps, name: RateLimitPolicyName) {
  return policyRateLimit(deps, name, (c) => [clientIp(c)]);
}

/** The more restrictive of two bucket verdicts (a rejection always wins). */
function pickStricter(
  current: RateLimitResult | null,
  candidate: RateLimitResult,
): RateLimitResult {
  if (!current) return candidate;
  if (current.allowed !== candidate.allowed) return current.allowed ? candidate : current;
  return candidate.remaining < current.remaining ? candidate : current;
}

/**
 * Per-IP *and* per-identifier policy for credential endpoints.
 *
 * Keying on the IP alone lets a botnet spread a password-spray across
 * addresses; keying on the identifier alone lets one attacker lock a victim
 * out of their own account. Both buckets are counted and the stricter verdict
 * wins, so neither attack works while a normal user (one IP, one email) is
 * unaffected.
 *
 * The identifier is read from the request body, so this middleware buffers and
 * caches the parsed JSON on the context for the handler to reuse.
 */
export function identifierRateLimit(
  deps: PolicyMiddlewareDeps,
  name: RateLimitPolicyName,
  identifier: (c: Context) => Promise<string | null | undefined>,
): MiddlewareHandler {
  const policy = deps.policies[name];

  return async (c, next) => {
    const buckets: string[] = [rateLimitKey(name, 'ip', clientIp(c))];
    const id = await identifier(c).catch(() => null);
    if (id) buckets.push(rateLimitKey(name, 'id', id));

    let worst: RateLimitResult | null = null;
    try {
      for (const bucket of buckets) {
        // Every bucket is counted (not short-circuited) so a burst is charged
        // to both the address and the account, not just whichever came first.
        const result = await deps.limiter.check(bucket, policy.max, policy.windowMs);
        worst = pickStricter(worst, result);
      }
    } catch (err) {
      deps.logger?.warn('rate limiter backend failed', {
        path: c.req.path,
        policy: policy.onError,
        err: String(err),
      });
      if (policy.onError === 'fail-closed') {
        const appErr = new AppError('UPSTREAM_UNAVAILABLE', 'rate limiting is unavailable');
        return c.json(appErr.toEnvelope(c.req.header('x-request-id')), 503, {
          'Retry-After': '5',
        });
      }
      await next();
      return undefined;
    }

    if (worst && !worst.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(worst.retryAfterMs / 1000));
      const err = new AppError('RATE_LIMITED', 'too many requests', {
        details: { retryAfterMs: worst.retryAfterMs },
      });
      return c.json(err.toEnvelope(c.req.header('x-request-id')), 429, {
        'Retry-After': String(retryAfterSec),
        'RateLimit-Limit': String(worst.limit),
        'RateLimit-Remaining': '0',
        'RateLimit-Reset': String(retryAfterSec),
        'X-RateLimit-Limit': String(worst.limit),
        'X-RateLimit-Remaining': '0',
      });
    }

    if (worst) {
      const resetSeconds = Math.max(0, Math.ceil((worst.resetAtMs - Date.now()) / 1000));
      c.header('RateLimit-Limit', String(worst.limit));
      c.header('RateLimit-Remaining', String(worst.remaining));
      c.header('RateLimit-Reset', String(resetSeconds));
      c.header('X-RateLimit-Limit', String(worst.limit));
      c.header('X-RateLimit-Remaining', String(worst.remaining));
    }
    await next();
    return undefined;
  };
}
