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

describe('user routes (auth-guarded)', () => {
  for (const path of [
    '/api/v1/favorites',
    '/api/v1/dashboard',
    '/api/v1/settings',
    '/api/v1/channels',
  ]) {
    test(`GET ${path} → 401 without a session`, async () => {
      const res = await createApp(fakeCtx()).request(path);
      expect(res.status).toBe(401);
    });
  }
});
