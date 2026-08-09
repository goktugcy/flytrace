import { describe, expect, it } from 'bun:test';
import { sql } from '@flytrace/db';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';
import { testContext } from '../testing/context.ts';
import { sanitizeDetail } from './routes.ts';

const TOKEN = 'internal-scrape-token-that-is-long-enough';

function ctx(config: Partial<AppContext['config']> = {}, healthy = true): AppContext {
  return testContext({
    // A deployed env needs a complete config: the app also refuses to boot
    // without EMAIL_API_KEY, which is not what these tests are about.
    config: { EMAIL_API_KEY: 'test-email-key', ...config },
    db: {
      execute: async (q: unknown) => {
        if (!healthy) throw new Error('connection to server at "db.internal" (10.0.0.5) failed');
        void q;
        return [] as unknown[];
      },
    } as unknown as AppContext['db'],
    redis: {
      ping: async () =>
        healthy ? 'PONG' : Promise.reject(new Error('redis://user:pw@cache:6379')),
    } as unknown as AppContext['redis'],
  });
}

describe('liveness and readiness', () => {
  it('GET /health is public and does not probe dependencies', async () => {
    // Dependencies are down, but liveness must still answer 200 — otherwise the
    // orchestrator restarts a healthy process during a database outage.
    const res = await createApp(ctx({}, false)).request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
  });

  it('GET /health/ready is public and reports dependency readiness', async () => {
    const res = await createApp(ctx()).request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, checks: { db: 'ok', redis: 'ok' } });
  });

  it('GET /health/ready answers 503 when a dependency is down', async () => {
    const res = await createApp(ctx({}, false)).request('/health/ready');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ready: boolean };
    expect(body.ready).toBe(false);
    // The failure reason (which names the host) stays in the logs.
    expect(JSON.stringify(body)).not.toContain('db.internal');
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('keeps /ready as an alias for existing probes', async () => {
    const res = await createApp(ctx()).request('/ready');
    expect(res.status).toBe(200);
  });
});

describe('internal endpoints', () => {
  const guarded = () => createApp(ctx({ APP_ENV: 'staging', INTERNAL_API_TOKEN: TOKEN }));

  it('answers 404 for /metrics without a token', async () => {
    // 404 rather than 401: a 401 confirms the endpoint exists.
    const res = await guarded().request('/metrics');
    expect(res.status).toBe(404);
  });

  it('answers 404 for /metrics with a WRONG token', async () => {
    const res = await guarded().request('/metrics', {
      headers: { authorization: `Bearer ${'y'.repeat(TOKEN.length)}` },
    });
    expect(res.status).toBe(404);
  });

  it('serves /metrics with the correct bearer token', async () => {
    const res = await guarded().request('/metrics', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('http_requests_total');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('accepts the X-Internal-Token header as well', async () => {
    const res = await guarded().request('/metrics', { headers: { 'x-internal-token': TOKEN } });
    expect(res.status).toBe(200);
  });

  it('ignores a token supplied in the query string', async () => {
    // Query strings land in proxy logs and Referer headers; they are never a
    // valid channel for a credential.
    const res = await guarded().request(`/metrics?token=${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it('guards /health/detailed the same way', async () => {
    expect((await guarded().request('/health/detailed')).status).toBe(404);
    const ok = await guarded().request('/health/detailed', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.status).toBe(200);
  });

  it('leaves the endpoints open in local development', async () => {
    const app = createApp(ctx({ APP_ENV: 'local' }));
    expect((await app.request('/metrics')).status).toBe(200);
    expect((await app.request('/health/detailed')).status).toBe(200);
  });

  it('refuses to build the app in production without an email transport', () => {
    // Password-reset links and security alerts would be accepted and silently
    // never delivered, so account recovery would look fine and not work.
    expect(() =>
      createApp(
        ctx({
          APP_ENV: 'production',
          // Satisfy the other production guards so this asserts the email rule
          // specifically, not whichever check happens to run first.
          INTERNAL_API_TOKEN: TOKEN,
          RATE_LIMIT_BACKEND: 'redis',
          MFA_CHALLENGE_BACKEND: 'redis',
          EMAIL_API_KEY: undefined,
        }),
      ),
    ).toThrow(/EMAIL_API_KEY is required/);
  });

  it('refuses to build the app in production without a token', () => {
    expect(() =>
      createApp(
        ctx({
          APP_ENV: 'production',
          // Satisfy the other production guards so this asserts the token rule
          // specifically, not whichever check happens to run first.
          RATE_LIMIT_BACKEND: 'redis',
          MFA_CHALLENGE_BACKEND: 'redis',
        }),
      ),
    ).toThrow(/INTERNAL_API_TOKEN is required/);
  });
});

describe('detailed health payload', () => {
  it('never leaks infrastructure detail from a failing dependency', async () => {
    const app = createApp(ctx({ APP_ENV: 'staging', INTERNAL_API_TOKEN: TOKEN }, false));
    const res = await app.request('/health/detailed', {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const raw = await res.text();

    expect(raw).not.toContain('db.internal');
    expect(raw).not.toContain('10.0.0.5');
    expect(raw).not.toContain('redis://');
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain(TOKEN);
    // The status signal itself still comes through.
    expect(raw).toContain('"status"');
  });

  it('sanitizeDetail keeps structured summaries and redacts everything else', () => {
    expect(sanitizeDetail('depth=12')).toBe('depth=12');
    expect(sanitizeDetail('connections=3')).toBe('connections=3');
    expect(sanitizeDetail('heap 42.0% (100/200)')).toBe('heap 42.0% (100/200)');
    expect(sanitizeDetail('timeout after 2000ms')).toBe('timeout after 2000ms');
    expect(sanitizeDetail('check failed: Error: connect ECONNREFUSED 10.0.0.5:5432')).toBe(
      'unavailable',
    );
    expect(sanitizeDetail(undefined)).toBeUndefined();
  });
});

describe('db check wiring', () => {
  it('uses the injected db handle', async () => {
    let queried = false;
    const app = createApp(
      testContext({
        db: {
          execute: async () => {
            queried = true;
            return [] as unknown[];
          },
        } as unknown as AppContext['db'],
        redis: { ping: async () => 'PONG' } as unknown as AppContext['redis'],
      }),
    );
    await app.request('/health/ready');
    expect(queried).toBe(true);
    void sql;
  });
});
