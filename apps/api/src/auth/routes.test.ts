import { describe, expect, test } from 'bun:test';
import type { AuthRepo, AuthUser, SessionWithUser } from '@flytrace/db';
import { AppError, isAppError, systemClock } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { attachSession, createAuthRoutes } from './routes.ts';
import { AuthService, type Hasher } from './service.ts';

const fakeHasher: Hasher = {
  hash: async (pw) => `h:${pw}`,
  verify: async (pw, h) => h === `h:${pw}`,
};

class InMemoryAuthRepo implements AuthRepo {
  private users = new Map<string, AuthUser & { passwordHash: string | null }>();
  private sessions = new Map<string, SessionWithUser>();
  private seq = 0;
  async findUserByEmail(email: string) {
    return this.users.get(email) ?? null;
  }
  async createUser(i: { email: string; name: string | null; passwordHash: string }) {
    this.seq += 1;
    const user: AuthUser = { id: `u${this.seq}`, email: i.email, name: i.name, role: 'user' };
    this.users.set(i.email, { ...user, passwordHash: i.passwordHash });
    return user;
  }
  async createSession(i: { userId: string; token: string; expiresAt: Date }) {
    const u = [...this.users.values()].find((x) => x.id === i.userId);
    if (!u) throw new Error('no user');
    this.sessions.set(i.token, {
      userId: i.userId,
      expiresAt: i.expiresAt.toISOString(),
      user: { id: u.id, email: u.email, name: u.name, role: u.role },
    });
  }
  async findSession(token: string) {
    return this.sessions.get(token) ?? null;
  }
  async deleteSession(token: string) {
    this.sessions.delete(token);
  }
}

function buildApp() {
  const service = new AuthService({
    repo: new InMemoryAuthRepo(),
    clock: systemClock,
    hasher: fakeHasher,
    sessionTtlMs: 60_000,
  });
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test');
    await next();
  });
  app.use('*', attachSession(service));
  app.route(
    '/',
    createAuthRoutes(service, { allowedOrigins: ['http://localhost:3000'], cookieSecure: false }),
  );
  // Mirror the real app's error mapper so thrown AppErrors map to their status.
  app.onError((err, c) => {
    if (isAppError(err)) return c.json(err.toEnvelope('test'), err.httpStatus as 400);
    return c.json(new AppError('INTERNAL', 'x').toEnvelope('test'), 500);
  });
  return app;
}

const ORIGIN = { 'content-type': 'application/json', origin: 'http://localhost:3000' };
const cookieFrom = (res: Response): string =>
  (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describe('auth routes', () => {
  test('sign-up sets a session cookie and /session reflects it', async () => {
    const app = buildApp();
    const up = await app.request('/sign-up', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    expect(up.status).toBe(201);
    const cookie = cookieFrom(up);
    expect(cookie).toContain('flytrace_session=');

    const sess = await app.request('/session', { headers: { cookie } });
    const body = (await sess.json()) as { data: { user: { email: string } | null } };
    expect(body.data.user?.email).toBe('a@example.com');
  });

  test('sign-in with a wrong password → 401', async () => {
    const app = buildApp();
    await app.request('/sign-up', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    const res = await app.request('/sign-in', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'a@example.com', password: 'nope' }),
    });
    expect(res.status).toBe(401);
  });

  test('rejects a cross-origin (CSRF) POST', async () => {
    const app = buildApp();
    const res = await app.request('/sign-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    expect(res.status).toBe(403);
  });

  test('sign-out revokes the session', async () => {
    const app = buildApp();
    const up = await app.request('/sign-up', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'a@example.com', password: 'hunter2!' }),
    });
    const cookie = cookieFrom(up);
    await app.request('/sign-out', { method: 'POST', headers: { ...ORIGIN, cookie } });
    const sess = await app.request('/session', { headers: { cookie } });
    const body = (await sess.json()) as { data: { user: unknown } };
    expect(body.data.user).toBeNull();
  });

  test('rejects invalid sign-up payloads (422)', async () => {
    const app = buildApp();
    const res = await app.request('/sign-up', {
      method: 'POST',
      headers: ORIGIN,
      body: JSON.stringify({ email: 'not-an-email', password: 'short' }),
    });
    expect(res.status).toBe(422);
  });
});
