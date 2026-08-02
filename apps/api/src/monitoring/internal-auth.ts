/**
 * Access control for operational endpoints (`/metrics`, `/health/detailed`).
 *
 * These endpoints are genuinely sensitive: `/metrics` exposes request volumes,
 * error rates, queue depth and connection counts (a free reconnaissance and
 * capacity-planning feed for an attacker, plus a cheap DoS amplifier because
 * rendering the registry is not free), and `/health/detailed` names every
 * dependency and its latency. Neither should be reachable from the public
 * internet.
 *
 * Defence is layered, and this module is the innermost layer — the one that
 * still holds if the reverse proxy is misconfigured or bypassed:
 *
 *   1. network — bind the ops port to a private network / expose only via the
 *      proxy (see deploy/nginx/flytrace.conf, which 403s these paths for
 *      non-internal source addresses);
 *   2. proxy   — allowlist by source CIDR;
 *   3. app     — this bearer-token check.
 *
 * Rules the token obeys:
 *   - read from the environment or the active secret provider at boot;
 *   - accepted ONLY from the `Authorization: Bearer` or `X-Internal-Token`
 *     header — never a query string, which would land in proxy access logs,
 *     browser history and `Referer` headers;
 *   - compared in constant time;
 *   - never logged, never echoed in an error message.
 *
 * Misconfiguration is not tolerated in production: `assertInternalAccessConfig`
 * refuses to boot rather than leaving these endpoints open or silently dark.
 */
import { AppError, timingSafeEqualString } from '@flytrace/shared';
import type { MiddlewareHandler } from 'hono';

export interface InternalAccessConfig {
  APP_ENV: string;
  /** Shared secret for internal scrapers. Required in production. */
  INTERNAL_API_TOKEN?: string | undefined;
  /**
   * Escape hatch for deployments that terminate access at the network edge and
   * genuinely have no way to inject a token (e.g. a Prometheus sidecar on a
   * private-only listener). Must be set deliberately; it is logged at boot.
   */
  INTERNAL_ENDPOINTS_NETWORK_ONLY?: boolean | undefined;
}

/** Minimum length that makes brute-forcing the token pointless. */
export const MIN_INTERNAL_TOKEN_LENGTH = 32;

export interface InternalAccessDecision {
  /** Whether the guarded endpoints should be mounted at all. */
  enabled: boolean;
  /** The token to check, or null when access is gated by the network only. */
  token: string | null;
  mode: 'token' | 'network-only' | 'open-local';
}

/**
 * Validate the operational-access configuration and decide how the endpoints
 * are protected. Throws — refusing to start — on any combination that would be
 * unsafe in production.
 */
export function resolveInternalAccess(cfg: InternalAccessConfig): InternalAccessDecision {
  const isProduction = cfg.APP_ENV === 'production' || cfg.APP_ENV === 'staging';
  const token = cfg.INTERNAL_API_TOKEN?.trim() || '';

  if (token) {
    if (token.length < MIN_INTERNAL_TOKEN_LENGTH) {
      throw new Error(
        `INTERNAL_API_TOKEN must be at least ${MIN_INTERNAL_TOKEN_LENGTH} characters (got ${token.length})`,
      );
    }
    return { enabled: true, token, mode: 'token' };
  }

  if (cfg.INTERNAL_ENDPOINTS_NETWORK_ONLY === true) {
    return { enabled: true, token: null, mode: 'network-only' };
  }

  if (isProduction) {
    throw new Error(
      'INTERNAL_API_TOKEN is required outside local development: /metrics and /health/detailed would otherwise be publicly readable. ' +
        'Set INTERNAL_API_TOKEN (≥32 chars), or set INTERNAL_ENDPOINTS_NETWORK_ONLY=true if access is already restricted at the network layer.',
    );
  }

  // Local development only: convenient, and never reached in a deployed env.
  return { enabled: true, token: null, mode: 'open-local' };
}

/**
 * Guard middleware. When a token is configured, the request must present it in
 * a header; otherwise the endpoint relies on the network/proxy layer.
 *
 * A missing or wrong token gets an identical 404 — not a 401. A 401 confirms
 * "there is a metrics endpoint here, keep guessing"; a 404 makes the endpoint
 * indistinguishable from one that does not exist.
 */
export function internalAccessGuard(decision: InternalAccessDecision): MiddlewareHandler {
  return async (c, next) => {
    if (decision.token === null) {
      await next();
      return;
    }

    const header = c.req.header('authorization');
    const bearer = header?.toLowerCase().startsWith('bearer ')
      ? header.slice('bearer '.length).trim()
      : undefined;
    const presented = bearer ?? c.req.header('x-internal-token')?.trim() ?? '';

    // Constant-time compare; the token itself is never logged or reflected.
    if (!presented || !timingSafeEqualString(presented, decision.token)) {
      throw new AppError('NOT_FOUND', 'Route not found');
    }

    await next();
  };
}
