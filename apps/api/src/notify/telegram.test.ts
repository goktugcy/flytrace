import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';

function fakeCtx(): AppContext {
  return {
    config: { CORS_ORIGINS: ['http://localhost:3000'], AUTH_SECRET: 'x'.repeat(16) },
    logger: createLogger({ level: 'error', base: {} }),
    clock: systemClock,
    db: { execute: async () => [] as unknown[] },
    redis: {},
    redisPrefix: 'test:',
    close: async () => {},
  } as unknown as AppContext;
}

describe('telegram routes', () => {
  test('link requires auth (401)', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/channels/telegram/link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  test('webhook accepts an update and returns ok (unknown token → no crash)', async () => {
    const res = await createApp(fakeCtx()).request('/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: { chat: { id: 123 }, text: '/start sometoken' } }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});
