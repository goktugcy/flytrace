import { AppError } from '@flytrace/shared';
import { Hono, type MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { clearSessionCookie, getSessionToken, setSessionCookie } from './cookie.ts';
import type { AuthService } from './service.ts';

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
  cookieSecure: boolean;
}

/** Better-Auth-shaped credentials routes under /api/auth (docs/11 §11.6). */
export function createAuthRoutes(service: AuthService, opts: AuthRoutesOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', csrfGuard(opts.allowedOrigins));

  app.post('/sign-up', async (c) => {
    const parsed = signUpSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid sign-up', { details: parsed.error.issues });
    const { user, token, expiresAt } = await service.signUp({
      email: parsed.data.email,
      password: parsed.data.password,
      name: parsed.data.name ?? null,
      ip: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    setSessionCookie(c, token, expiresAt, opts.cookieSecure);
    return c.json({ data: { user }, meta: { requestId: c.get('requestId') } }, 201);
  });

  app.post('/sign-in', async (c) => {
    const parsed = signInSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid sign-in', { details: parsed.error.issues });
    const { user, token, expiresAt } = await service.signIn({
      ...parsed.data,
      ip: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
    });
    setSessionCookie(c, token, expiresAt, opts.cookieSecure);
    return c.json({ data: { user }, meta: { requestId: c.get('requestId') } });
  });

  app.post('/sign-out', async (c) => {
    await service.signOut(getSessionToken(c));
    clearSessionCookie(c);
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
