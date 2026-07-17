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
    redis: { llen: async () => 0, zcard: async () => 0 },
    redisPrefix: 'test:',
    close: async () => {},
  } as unknown as AppContext;
}

describe('admin routes', () => {
  for (const p of ['stats', 'queues', 'providers', 'flights', 'dlq']) {
    test(`GET /admin/${p} → 401 without a session`, async () => {
      const res = await createApp(fakeCtx()).request(`/api/v1/admin/${p}`);
      expect(res.status).toBe(401);
    });
  }
});
