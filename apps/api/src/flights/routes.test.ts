import { describe, expect, test } from 'bun:test';
import { createLogger, systemClock } from '@flytrace/shared';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';

const PREFIX = 'test:';

class FakeRedis {
  sets = new Map<string, Set<string>>();
  strings = new Map<string, string>();
  async smembers(k: string): Promise<string[]> {
    return [...(this.sets.get(k) ?? [])];
  }
  async mget(keys: string[]): Promise<(string | null)[]> {
    return keys.map((k) => this.strings.get(k) ?? null);
  }
  async scard(k: string): Promise<number> {
    return this.sets.get(k)?.size ?? 0;
  }
}

function fakeCtx(redis: FakeRedis): AppContext {
  return {
    config: { CORS_ORIGINS: ['http://localhost:3000'], AUTH_SECRET: 'x'.repeat(16) },
    logger: createLogger({ level: 'error', base: {} }),
    clock: systemClock,
    db: { execute: async () => [] as unknown[] },
    redis,
    redisPrefix: PREFIX,
    close: async () => {},
  } as unknown as AppContext;
}

function seed(r: FakeRedis, id: string, lat: number, lon: number): void {
  r.sets.set(
    `${PREFIX}flights:active`,
    new Set([...(r.sets.get(`${PREFIX}flights:active`) ?? []), id]),
  );
  r.strings.set(
    `${PREFIX}flight:state:${id}`,
    JSON.stringify({
      flightId: id,
      icao24: 'a',
      callsign: 'THY1',
      lat,
      lon,
      altFt: 30000,
      headingDeg: 90,
      gsKt: 450,
      airborne: true,
      lastTs: '2023-11-14T22:13:20.000Z',
    }),
  );
}

describe('flight read routes', () => {
  test('GET /flights/live returns hot-state flights (cached)', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29);
    const res = await createApp(fakeCtx(r)).request('/api/v1/flights/live');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { count: number; flights: unknown[] };
      meta: { cached: boolean };
    };
    expect(body.data.count).toBe(1);
    expect(body.meta.cached).toBe(true);
  });

  test('GET /flights/live?bbox clips to the viewport', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29); // inside
    seed(r, 'F2', 10, 10); // outside
    const res = await createApp(fakeCtx(r)).request('/api/v1/flights/live?bbox=28,40,33,42');
    const body = (await res.json()) as { data: { count: number } };
    expect(body.data.count).toBe(1);
  });

  test('GET /flights/live rejects a malformed bbox', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request(
      '/api/v1/flights/live?bbox=1,2,3',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('GET /stats/live returns counters', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29);
    const res = await createApp(fakeCtx(r)).request('/api/v1/stats/live');
    const body = (await res.json()) as { data: { flightsLive: number; eventsToday: number } };
    expect(body.data.flightsLive).toBe(1);
    expect(body.data.eventsToday).toBe(0);
  });

  test('GET /flights/id/:flightId → 404 when unknown', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request(
      '/api/v1/flights/id/00000000-0000-7000-8000-000000000009',
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FLIGHT_NOT_FOUND');
  });

  test('GET /flights/:callsign/:date → 404 when unknown', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/TK1/2023-11-14');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FLIGHT_NOT_FOUND');
  });

  test('GET /flights/:callsign/:date → 400 on a malformed date', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/TK1/not-a-date');
    expect(res.status).toBe(400);
  });
});
