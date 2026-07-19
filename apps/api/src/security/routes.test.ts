import { describe, expect, test } from 'bun:test';
import type { AuthUser } from '@flytrace/db';
import { AppError, isAppError } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import { InMemoryRateLimiter } from './edge/rate-limit.ts';
import { type SecurityRoutesDeps, createSecurityRoutes } from './routes.ts';

const ORIGIN = 'http://localhost:3000';
const USER: AuthUser = {
  id: 'user-1',
  email: 'u@example.test',
  name: null,
  role: 'user',
};

function buildDeps(): SecurityRoutesDeps & {
  auditEntries: Array<{ action: string; meta?: Record<string, unknown> }>;
  revokedDevices: string[];
  revokedRefreshDevices: string[];
  revokedSessions: Array<string | undefined>;
} {
  const auditEntries: Array<{ action: string; meta?: Record<string, unknown> }> = [];
  const revokedDevices: string[] = [];
  const revokedRefreshDevices: string[] = [];
  const revokedSessions: Array<string | undefined> = [];

  return {
    auditEntries,
    revokedDevices,
    revokedRefreshDevices,
    revokedSessions,
    mfa: {
      async beginEnrollment() {
        return { secret: 'SETUPSECRET', otpauthUri: 'otpauth://totp/FlyTrace:u' };
      },
      async confirmEnrollment() {
        return { backupCodes: ['AAAA-BBBB', 'CCCC-DDDD'] };
      },
      async verify() {
        return 'backup_code';
      },
      async regenerateBackupCodes() {
        return { backupCodes: ['EEEE-FFFF'] };
      },
      async disable() {},
    },
    devices: {
      async listDevices() {
        return [
          {
            id: 'dev-1',
            userId: USER.id,
            fingerprint: 'fingerprint',
            ua: 'UA/1',
            lastIp: '203.0.113.10',
            trusted: false,
            lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ];
      },
      async revokeDevice(id) {
        revokedDevices.push(id);
      },
    },
    refreshTokens: {
      async revoke() {},
      async revokeAllForUser() {},
      async revokeAllForDevice(deviceId) {
        revokedRefreshDevices.push(deviceId);
      },
    },
    audit: {
      async record(entry) {
        auditEntries.push({ action: entry.action, ...(entry.meta ? { meta: entry.meta } : {}) });
      },
      async list() {
        return [];
      },
    },
    async verifyPassword(_user, password) {
      if (password !== 'correct-password') throw new AppError('UNAUTHENTICATED', 'bad password');
    },
    async revokeSession(sessionToken) {
      revokedSessions.push(sessionToken);
    },
  };
}

function buildApp(deps = buildDeps(), user: AuthUser | null = USER, rateLimitMax = 50) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-request');
    c.set('user', user);
    c.set('sessionToken', 'session-token');
    await next();
  });
  app.route(
    '/',
    createSecurityRoutes(deps, {
      allowedOrigins: [ORIGIN],
      rateLimitMax,
      rateLimitWindowMs: 60_000,
    }),
  );
  app.onError((err, c) => {
    if (isAppError(err)) return c.json(err.toEnvelope('test-request'), err.httpStatus as 400);
    return c.json(new AppError('INTERNAL', 'x').toEnvelope('test-request'), 500);
  });
  return { app, deps };
}

const jsonHeaders = {
  'content-type': 'application/json',
  origin: ORIGIN,
};

describe('security routes', () => {
  test('accepts public CSP reports and sanitizes URL metadata', async () => {
    const deps = buildDeps();
    const { app } = buildApp(deps, null);
    const res = await app.request('/security/csp-report', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({
        'csp-report': {
          'document-uri': 'https://app.example.test/map?token=secret#hash',
          'effective-directive': 'script-src',
          'violated-directive': 'script-src-elem',
          'blocked-uri': 'https://cdn.example.test/lib.js?api_key=secret',
          'source-file': 'https://app.example.test/_next/static/app.js?x=y',
          disposition: 'report',
          'line-number': 12,
        },
      }),
    });
    expect(res.status).toBe(202);
    expect(deps.auditEntries[0]).toEqual({
      action: 'csp.violation_reported',
      meta: {
        documentUri: 'https://app.example.test/map',
        effectiveDirective: 'script-src',
        violatedDirective: 'script-src-elem',
        blockedUri: 'https://cdn.example.test/lib.js',
        sourceFile: 'https://app.example.test/_next/static/app.js',
        disposition: 'report',
        lineNumber: 12,
      },
    });
    expect(JSON.stringify(deps.auditEntries)).not.toContain('secret');
  });

  test('rejects oversized CSP reports', async () => {
    const { app } = buildApp(buildDeps(), null);
    const res = await app.request('/security/csp-report', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ 'csp-report': { 'blocked-uri': 'x'.repeat(9000) } }),
    });
    expect(res.status).toBe(413);
  });

  test('requires an authenticated user', async () => {
    const { app } = buildApp(buildDeps(), null);
    const res = await app.request('/security/devices');
    expect(res.status).toBe(401);
  });

  test('starts and confirms MFA without writing secrets to audit metadata', async () => {
    const { app, deps } = buildApp();
    const setup = await app.request('/security/mfa/setup', {
      method: 'POST',
      headers: { origin: ORIGIN },
    });
    expect(setup.status).toBe(200);
    const setupBody = (await setup.json()) as { data: { secret: string; otpauthUri: string } };
    expect(setupBody.data.secret).toBe('SETUPSECRET');
    expect(setupBody.data.otpauthUri).toContain('otpauth://totp/');

    const confirm = await app.request('/security/mfa/confirm', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ token: '123456' }),
    });
    expect(confirm.status).toBe(200);
    const confirmBody = (await confirm.json()) as { data: { backupCodes: string[] } };
    expect(confirmBody.data.backupCodes).toEqual(['AAAA-BBBB', 'CCCC-DDDD']);

    expect(deps.auditEntries.map((e) => e.action)).toEqual(['mfa.setup_started', 'mfa.enabled']);
    expect(JSON.stringify(deps.auditEntries)).not.toContain('SETUPSECRET');
    expect(JSON.stringify(deps.auditEntries)).not.toContain('123456');
  });

  test('verifies TOTP or backup-code challenge', async () => {
    const { app, deps } = buildApp();
    const res = await app.request('/security/mfa/verify', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ token: 'AAAA-BBBB' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { method: string } };
    expect(body.data.method).toBe('backup_code');
    expect(deps.auditEntries[0]?.meta).toEqual({ method: 'backup_code' });
  });

  test('protects critical MFA changes with password reauthentication', async () => {
    const { app, deps } = buildApp();
    const bad = await app.request('/security/mfa/disable', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);

    const ok = await app.request('/security/mfa/backup-codes/refresh', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password: 'correct-password' }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { backupCodes: string[] } };
    expect(body.data.backupCodes).toEqual(['EEEE-FFFF']);
    expect(deps.auditEntries[0]?.action).toBe('mfa.backup_codes_refreshed');
  });

  test('lists and revokes devices with their refresh tokens', async () => {
    const { app, deps } = buildApp();
    const list = await app.request('/security/devices');
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { data: { items: Array<{ id: string }> } };
    expect(listBody.data.items[0]?.id).toBe('dev-1');

    const revoked = await app.request('/security/devices/dev-1', {
      method: 'DELETE',
      headers: jsonHeaders,
      body: JSON.stringify({ password: 'correct-password' }),
    });
    expect(revoked.status).toBe(200);
    expect(deps.revokedRefreshDevices).toEqual(['dev-1']);
    expect(deps.revokedDevices).toEqual(['dev-1']);
  });

  test('revokes the current server session and clears its cookie', async () => {
    const { app, deps } = buildApp();
    const res = await app.request('/security/sessions/revoke-current', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ password: 'correct-password' }),
    });
    expect(res.status).toBe(200);
    expect(deps.revokedSessions).toEqual(['session-token']);
    expect(res.headers.get('set-cookie')).toContain('flytrace_session=');
  });

  test('rejects cross-origin state changes', async () => {
    const { app } = buildApp();
    const res = await app.request('/security/mfa/setup', {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  test('applies a route-level rate limit', async () => {
    const deps = buildDeps();
    deps.rateLimiter = new InMemoryRateLimiter(() => 0);
    const { app } = buildApp(deps, USER, 1);
    expect((await app.request('/security/devices')).status).toBe(200);
    expect((await app.request('/security/devices')).status).toBe(429);
  });
});
