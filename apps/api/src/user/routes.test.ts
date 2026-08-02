import { describe, expect, test } from 'bun:test';
import { createApp } from '../app.ts';
import { testContext } from '../testing/context.ts';

const fakeCtx = () => testContext();

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
