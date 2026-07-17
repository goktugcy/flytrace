import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from './app.ts';
import type { AppContext } from './context.ts';

/** Minimal fake context — /health and routing don't touch db/redis. */
function fakeCtx(): AppContext {
  return {
    config: { CORS_ORIGINS: ['http://localhost:3000'] },
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
