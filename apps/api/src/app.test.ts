import { describe, expect, test } from 'bun:test';
import { createApp } from './app.ts';
import type { AppContext } from './context.ts';
import { testContext } from './testing/context.ts';

const fakeCtx = (config: Partial<AppContext['config']> = {}): AppContext => testContext({ config });

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
