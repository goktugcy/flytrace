import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

/**
 * Auth cookies (docs/15 §15.1).
 *
 * Two cookies with deliberately different scopes:
 *
 *   - `flytrace_session` — the session bearer. Sent on every API call, so
 *     `Path=/`.
 *   - `flytrace_refresh` — the long-lived rotation credential. Scoped to
 *     `Path=/api/auth` so it is NOT attached to ordinary API traffic; an XSS or
 *     a logging proxy that sees normal requests never sees it, and its blast
 *     radius on any single leaked request is smaller.
 *
 * Both are `HttpOnly` (unreadable from JavaScript) and `Secure` outside local
 * development. `SameSite=Lax` is the default: the browser withholds them from
 * cross-site POSTs, which is the CSRF-relevant case, while still sending them
 * on top-level navigations. The web app and API are same-site in every real
 * deployment (`flytrace.com` / `api.flytrace.com`), so `Lax` costs nothing —
 * set `SESSION_COOKIE_SAMESITE=None` (which forces `Secure`) only for a genuine
 * cross-site split, and note that this weakens CSRF protection to the Origin
 * check in `csrfGuard` alone.
 */

export const SESSION_COOKIE = 'flytrace_session';
export const REFRESH_COOKIE = 'flytrace_refresh';

/** Refresh cookie scope — narrower than the session cookie on purpose. */
export const REFRESH_COOKIE_PATH = '/api/auth';

export type SameSitePolicy = 'Lax' | 'Strict' | 'None';

export interface CookieOptions {
  /** `Secure` flag. Must be true anywhere that is not local http. */
  secure: boolean;
  sameSite: SameSitePolicy;
  /** Optional cookie domain, e.g. `.flytrace.com` for subdomain sharing. */
  domain?: string | undefined;
}

function baseAttributes(opts: CookieOptions) {
  // SameSite=None is meaningless (and rejected by browsers) without Secure.
  const secure = opts.sameSite === 'None' ? true : opts.secure;
  return {
    httpOnly: true as const,
    sameSite: opts.sameSite,
    secure,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

export function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: Date,
  opts: CookieOptions,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    ...baseAttributes(opts),
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context, opts?: CookieOptions): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    ...(opts?.domain ? { domain: opts.domain } : {}),
  });
}

export function setRefreshCookie(
  c: Context,
  token: string,
  expiresAt: Date,
  opts: CookieOptions,
): void {
  setCookie(c, REFRESH_COOKIE, token, {
    ...baseAttributes(opts),
    path: REFRESH_COOKIE_PATH,
    expires: expiresAt,
  });
}

export function clearRefreshCookie(c: Context, opts?: CookieOptions): void {
  deleteCookie(c, REFRESH_COOKIE, {
    path: REFRESH_COOKIE_PATH,
    ...(opts?.domain ? { domain: opts.domain } : {}),
  });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function getRefreshToken(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}
