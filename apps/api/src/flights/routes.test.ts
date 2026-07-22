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

  test('GET /flights/live/viewport merges live ADS-B aircraft for the visible region', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toContain('/lat/');
      return new Response(
        JSON.stringify({
          ac: [
            {
              hex: '4bc854',
              flight: 'PGT438B ',
              lat: 41.16,
              lon: 27.71,
              alt_baro: 22875,
              alt_geom: 23500,
              gs: 335.4,
              track: 98.2,
              baro_rate: -64,
              squawk: '2142',
              category: 'A3',
              seen_pos: 1,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const res = await createApp(fakeCtx(new FakeRedis())).request(
        '/api/v1/flights/live/viewport?bbox=27.5,40.3,30.5,42.1',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { count: number; flights: Array<{ flightId: string; source?: string }> };
      };
      expect(body.data.count).toBe(1);
      expect(body.data.flights[0]?.flightId).toBe('adsb:4bc854');
      expect(body.data.flights[0]?.source).toBe('adsb');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('GET /flights/route validates a fallback route against live telemetry', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      const southbound = String(url).includes('TST101');
      return new Response(
        JSON.stringify({
          response: {
            flightroute: {
              airline: { name: 'Test Air' },
              origin: southbound
                ? {
                    iata_code: 'IST',
                    name: 'Istanbul',
                    municipality: 'Istanbul',
                    latitude: 41.2753,
                    longitude: 28.7519,
                  }
                : {
                    iata_code: 'AYT',
                    name: 'Antalya',
                    municipality: 'Antalya',
                    latitude: 36.8987,
                    longitude: 30.8005,
                  },
              destination: southbound
                ? {
                    iata_code: 'AYT',
                    name: 'Antalya',
                    municipality: 'Antalya',
                    latitude: 36.8987,
                    longitude: 30.8005,
                  }
                : {
                    iata_code: 'IST',
                    name: 'Istanbul',
                    municipality: 'Istanbul',
                    latitude: 41.2753,
                    longitude: 28.7519,
                  },
            },
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const query = 'date=2026-07-22&lat=39.2&lon=29.7&headingDeg=160&onGround=false';
      const accepted = await createApp(fakeCtx(new FakeRedis())).request(
        `/api/v1/flights/route/TST101?${query}`,
      );
      const acceptedBody = (await accepted.json()) as {
        data: { route: { source: string; origin: { iata: string } } | null };
      };
      expect(acceptedBody.data.route?.source).toBe('adsbdb');
      expect(acceptedBody.data.route?.origin.iata).toBe('IST');

      const rejected = await createApp(fakeCtx(new FakeRedis())).request(
        `/api/v1/flights/route/TST102?${query}`,
      );
      expect(((await rejected.json()) as { data: { route: unknown } }).data.route).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('POST /flights/live/tracks returns empty when no DB history exists', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/live/tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        flights: [{ flightId: 'adsb:4bc854', icao24: '4bc854' }],
        limitPerFlight: 10,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tracks: unknown[] } };
    expect(body.data.tracks).toEqual([]);
  });

  test('GET /flights/live rejects a malformed bbox', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request(
      '/api/v1/flights/live?bbox=1,2,3',
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BAD_REQUEST');
  });

  test('GET /flights/search returns results (empty query → [])', async () => {
    const empty = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/search');
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { data: { results: unknown[] } }).data.results).toEqual([]);

    const res = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/search?q=TK');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { results: unknown[] } };
    expect(Array.isArray(body.data.results)).toBe(true);
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

  test('GET /flights/id/adsb:<hex> returns live ADS-B detail', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(String(url)).toContain('/hex/4bc855');
      return new Response(
        JSON.stringify({
          ac: [
            {
              hex: '4bc855',
              flight: 'PGT438B ',
              lat: 41.16,
              lon: 27.71,
              alt_baro: 22875,
              alt_geom: 23500,
              gs: 335.4,
              track: 98.2,
              baro_rate: -64,
              squawk: '2142',
              category: 'A3',
              seen_pos: 1,
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    try {
      const res = await createApp(fakeCtx(new FakeRedis())).request(
        '/api/v1/flights/id/adsb%3A4bc855',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { flight: { flightId: string; callsign: string }; live: { icao24?: string } };
      };
      expect(body.data.flight.flightId).toBe('adsb:4bc855');
      expect(body.data.flight.callsign).toBe('PGT438B');
      expect(body.data.live.icao24).toBe('4bc855');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('GET /flights/id/adsb:<hex>/track returns empty when there is no persisted match', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request(
      '/api/v1/flights/id/adsb%3A4bc854/track',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { points: unknown[]; count: number } };
    expect(body.data.points).toEqual([]);
    expect(body.data.count).toBe(0);
  });

  test('POST /flights/live/promote requires auth', async () => {
    const res = await createApp(fakeCtx(new FakeRedis())).request('/api/v1/flights/live/promote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' },
      body: JSON.stringify({ flightId: 'adsb:4bc854' }),
    });
    expect(res.status).toBe(401);
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
