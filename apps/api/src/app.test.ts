import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from './app.ts';
import type { AppContext } from './context.ts';

/** Minimal fake context — /health and routing don't touch db/redis. */
function fakeCtx(config: Record<string, unknown> = {}): AppContext {
  return {
    config: {
      APP_ENV: 'local',
      AUTH_SECRET: 'test-auth-secret-at-least-16-chars',
      AUDIT_BACKEND: 'memory',
      CORS_ORIGINS: ['http://localhost:3000'],
      MFA_ISSUER: 'FlyTrace',
      RATE_LIMIT_MAX: 100,
      RATE_LIMIT_WINDOW_MS: 60_000,
      SESSION_REFRESH_TTL_DAYS: 30,
      CSP_MODE: 'off',
      CSP_CONNECT_SRC: [],
      CSP_IMG_SRC: [],
      CSP_SCRIPT_SRC: [],
      CSP_STYLE_SRC: [],
      CSP_FONT_SRC: [],
      CSP_FRAME_SRC: [],
      TURNSTILE_ENABLED: false,
      TURNSTILE_FAIL_OPEN: false,
      TURNSTILE_EXPECTED_ACTION: 'turnstile-spin-v1',
      ...config,
    },
    logger: createLogger({ level: 'error' }),
    clock: systemClock,
    db: {},
    redis: {},
    close: async () => {},
  } as unknown as AppContext;
}

describe('api app', () => {
  const app = createApp(fakeCtx());

  test('GET /health → ok', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body.status).toBe('ok');
    expect(body.service).toBe('api');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  test('GET /api/v1 → envelope with requestId', async () => {
    const res = await app.request('/api/v1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown; meta: { requestId: string } };
    expect(body.data).toBeDefined();
    expect(body.meta.requestId).toBeTruthy();
  });

  test('CSP is opt-in and supports report-only mode', async () => {
    const off = await createApp(fakeCtx()).request('/health');
    expect(off.headers.get('content-security-policy')).toBeNull();
    expect(off.headers.get('content-security-policy-report-only')).toBeNull();

    const reportOnly = await createApp(
      fakeCtx({
        CSP_MODE: 'report-only',
        CSP_REPORT_URI: '/api/v1/security/csp-report',
        CSP_CONNECT_SRC: ['https://api.flytrace.test', 'wss://api.flytrace.test'],
        CSP_IMG_SRC: ['https://tiles.openfreemap.org'],
      }),
    ).request('/health');
    expect(reportOnly.headers.get('content-security-policy')).toBeNull();
    const csp = reportOnly.headers.get('content-security-policy-report-only') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain('https://api.flytrace.test');
    expect(csp).toContain('https://tiles.openfreemap.org');
    expect(csp).toContain('report-uri /api/v1/security/csp-report');
  });

  test('GET /metrics → Prometheus text', async () => {
    const res = await app.request('/metrics');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('http_requests_total');
    expect(res.headers.get('content-type')).toContain('text/plain');
  });

  test('unknown route → 404 error envelope', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
