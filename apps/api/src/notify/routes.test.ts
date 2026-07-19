import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';

function fakeCtx(): AppContext {
  return {
    config: {
      CORS_ORIGINS: ['http://localhost:3000'],
      AUTH_SECRET: 'x'.repeat(16),
      WEB_PUSH_PUBLIC_KEY: 'VAPID_PUB',
    },
    logger: createLogger({ level: 'error', base: {} }),
    clock: systemClock,
    db: { execute: async () => [] as unknown[] },
    redis: { smembers: async () => [], scard: async () => 0 },
    redisPrefix: 'test:',
    close: async () => {},
  } as unknown as AppContext;
}

describe('notify routes', () => {
  test('watchlist requires auth (401 without a session)', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/watchlist');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNAUTHENTICATED');
  });

  test('POST /channels/webpush/subscribe requires auth', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/channels/webpush/subscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({
        endpoint: 'https://push.example/x',
        keys: { p256dh: 'p', auth: 'a' },
      }),
    });
    expect(res.status).toBe(401);
  });

  test('PATCH /watchlist/:id requires auth', async () => {
    const res = await createApp(fakeCtx()).request(
      '/api/v1/watchlist/00000000-0000-7000-8000-000000000001',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ active: false }),
      },
    );
    expect(res.status).toBe(401);
  });

  test('PATCH /channels/:id requires auth', async () => {
    const res = await createApp(fakeCtx()).request(
      '/api/v1/channels/00000000-0000-7000-8000-000000000001',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(res.status).toBe(401);
  });

  test('DELETE /channels/:id requires auth', async () => {
    const res = await createApp(fakeCtx()).request(
      '/api/v1/channels/00000000-0000-7000-8000-000000000001',
      {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000' },
      },
    );
    expect(res.status).toBe(401);
  });

  test('GET /config/webpush is public and returns the VAPID key', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/config/webpush');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { publicKey: string } };
    expect(body.data.publicKey).toBe('VAPID_PUB');
  });
});
