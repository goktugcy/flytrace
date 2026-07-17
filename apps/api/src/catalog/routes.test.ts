import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';

function fakeCtx(rows: unknown[] = []): AppContext {
  return {
    config: { CORS_ORIGINS: ['http://localhost:3000'], AUTH_SECRET: 'x'.repeat(16) },
    logger: createLogger({ level: 'error', base: {} }),
    clock: systemClock,
    db: { execute: async () => rows },
    redis: {},
    redisPrefix: 'test:',
    close: async () => {},
  } as unknown as AppContext;
}

describe('catalog routes', () => {
  test('GET /airports/:iata → 400 for a non-3-letter code', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/airports/ISTANBUL');
    expect(res.status).toBe(400);
  });

  test('GET /airports/:iata → 404 when the airport is unknown', async () => {
    const res = await createApp(fakeCtx([])).request('/api/v1/airports/ZZZ');
    expect(res.status).toBe(404);
  });

  test('GET /aircraft/:registration → 404 when the tail is unknown', async () => {
    const res = await createApp(fakeCtx([])).request('/api/v1/aircraft/TC-ZZZ');
    expect(res.status).toBe(404);
  });
});
