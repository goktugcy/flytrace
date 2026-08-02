import { describe, expect, test } from 'bun:test';
import { createApp } from '../app.ts';
import type { AppContext } from '../context.ts';
import { testContext } from '../testing/context.ts';

const fakeCtx = (rows: unknown[] = []): AppContext => testContext({ dbRows: rows });

describe('catalog routes', () => {
  test('GET /airports/viewport returns airport GeoJSON features', async () => {
    const res = await createApp(
      fakeCtx([
        {
          id: '00000000-0000-7000-8000-000000000001',
          iata: 'IST',
          icao: 'LTFM',
          name: 'Istanbul Airport',
          type: 'large_airport',
          city: 'Istanbul',
          country: 'TR',
          elevationFt: 325,
          lat: 41.2753,
          lon: 28.7519,
          runwayCount: 5,
          scheduledService: true,
          homeUrl: null,
          wikipediaUrl: null,
        },
      ]),
    ).request('/api/v1/airports/viewport?bbox=27,40,30,42&zoom=7');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { count: number; features: Array<{ properties: { iata: string | null } }> };
    };
    expect(body.data.count).toBe(1);
    expect(body.data.features[0]?.properties.iata).toBe('IST');
  });

  test('GET /airports/id/:id rejects malformed ids', async () => {
    const res = await createApp(fakeCtx()).request('/api/v1/airports/id/not-a-uuid');
    expect(res.status).toBe(400);
  });

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
