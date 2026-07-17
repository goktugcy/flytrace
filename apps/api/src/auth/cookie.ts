import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';

export const SESSION_COOKIE = 'flytrace_session';

/** Set the session cookie (httpOnly, SameSite=Lax; Secure in non-local envs). */
export function setSessionCookie(
  c: Context,
  token: string,
  expiresAt: Date,
  secure: boolean,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export function getSessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}
