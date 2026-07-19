import { describe, expect, test } from 'bun:test';
import { createLogger, isAppError } from '@flytrace/shared';
import { Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import { createAirspaceRoutes } from './routes.ts';

/**
 * Mount the airspace routes on a bare app with the same request-id middleware +
 * error mapping the real app applies, so AppError → its HTTP status. The route
 * defaults to the in-repo mock provider (no AIRSPACE_PROVIDER env), so this test
 * runs fully offline.
 */
function makeApp() {
  const ctx = {
    logger: createLogger({ level: 'error', base: {} }),
  } as unknown as AppContext;

  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'test-req');
    await next();
  });
  app.onError((err, c) => {
    if (isAppError(err)) return c.json(err.toEnvelope(c.get('requestId')), err.httpStatus as 400);
    throw err;
  });
  app.route('/api/v1', createAirspaceRoutes(ctx));
  return app;
}

describe('GET /airspace/current', () => {
  test('400 when lat is missing/invalid', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lon=28.75');
    expect(res.status).toBe(400);
  });

  test('400 when lon is out of range', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lat=41&lon=999');
    expect(res.status).toBe(400);
  });

  test('400 when alt is non-numeric', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lat=41.26&lon=28.75&alt=high');
    expect(res.status).toBe(400);
  });

  test('200 over Istanbul returns grouped matches + primary controller', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lat=41.26&lon=28.75');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        fir: { id: string }[];
        tma: { id: string }[];
        ctr: { id: string }[];
        name: string | null;
        class: string | null;
        frequency: string | null;
        matches: { id: string }[];
      };
    };
    const d = body.data;
    expect(d.fir.map((a) => a.id)).toEqual(['mock-ltbb-fir']);
    expect(d.tma.map((a) => a.id)).toEqual(['mock-ist-tma']);
    expect(d.ctr.map((a) => a.id)).toEqual(['mock-ist-ctr']);
    expect(d.matches).toHaveLength(3);
    // Most specific volume (CTR) supplies the primary class/frequency/name.
    expect(d.name).toBe('ISTANBUL CTR');
    expect(d.class).toBe('D');
    expect(d.frequency).toBe('129.300');
  });

  test('200 with altitude filter drops the CTR above its ceiling', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lat=41.26&lon=28.75&alt=10000');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { matches: { id: string }[]; name: string } };
    const ids = body.data.matches.map((a) => a.id);
    expect(ids).not.toContain('mock-ist-ctr');
    // TMA is now the most specific controlling volume.
    expect(body.data.name).toBe('ISTANBUL TMA');
  });

  test('200 over open sea returns no matches', async () => {
    const res = await makeApp().request('/api/v1/airspace/current?lat=0&lon=0');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { matches: unknown[]; name: null } };
    expect(body.data.matches).toEqual([]);
    expect(body.data.name).toBeNull();
  });
});

describe('GET /airspace/viewport', () => {
  test('400 when bbox is missing/invalid', async () => {
    const res = await makeApp().request('/api/v1/airspace/viewport?bbox=28,40,30');
    expect(res.status).toBe(400);
  });

  test('200 returns GeoJSON features for the requested bbox', async () => {
    const res = await makeApp().request(
      '/api/v1/airspace/viewport?bbox=28,40,30,42&types=CTR,TMA&limit=10',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        type: 'FeatureCollection';
        count: number;
        truncated: boolean;
        features: { geometry: { type: string }; properties: { id: string; type: string } }[];
      };
    };
    expect(body.data.type).toBe('FeatureCollection');
    expect(body.data.truncated).toBe(false);
    expect(body.data.features.map((feature) => feature.properties.id).sort()).toEqual([
      'mock-ist-ctr',
      'mock-ist-tma',
    ]);
    expect(body.data.features.every((feature) => feature.geometry.type === 'Polygon')).toBe(true);
  });
});
