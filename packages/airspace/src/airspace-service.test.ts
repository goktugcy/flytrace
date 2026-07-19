import { describe, expect, test } from 'bun:test';
import { AirspaceService, groupByType, withinBand } from './airspace-service.ts';
import { MOCK_AIRSPACES, MockAirspaceProvider } from './providers/mock.ts';

/** A point inside Istanbul TMA + CTR + FIR (new airport LTFM ≈ 41.26N, 28.75E). */
const IST = { lat: 41.26, lon: 28.75 };
/** A point inside the Istanbul FIR only (SW Anatolia, clear of every TMA/CTR). */
const FIR_ONLY = { lat: 37.0, lon: 34.0 };
/** A point outside every mock volume. */
const OUTSIDE = { lat: 10.0, lon: 10.0 };

async function loadedService(opts?: ConstructorParameters<typeof AirspaceService>[1]) {
  const svc = new AirspaceService(new MockAirspaceProvider(), opts);
  await svc.load();
  return svc;
}

describe('AirspaceService — mock dataset lookup', () => {
  test('loads and reports isLoaded', async () => {
    const svc = await loadedService();
    expect(svc.isLoaded).toBe(true);
  });

  test('currentAirspace over IST returns TMA + CTR + FIR', async () => {
    const svc = await loadedService();
    const ids = new Set(svc.currentAirspace(IST.lat, IST.lon).map((a) => a.id));
    expect(ids).toEqual(new Set(['mock-ist-tma', 'mock-ist-ctr', 'mock-ltbb-fir']));
  });

  test('a FIR-only point matches just the FIR', async () => {
    const svc = await loadedService();
    const matches = svc.currentAirspace(FIR_ONLY.lat, FIR_ONLY.lon);
    expect(matches.map((a) => a.id)).toEqual(['mock-ltbb-fir']);
  });

  test('a point outside every volume matches nothing', async () => {
    const svc = await loadedService();
    expect(svc.currentAirspace(OUTSIDE.lat, OUTSIDE.lon)).toEqual([]);
  });

  test('altitude filter excludes volumes whose band the altitude misses', async () => {
    const svc = await loadedService();
    // 10 000 ft over IST: above the CTR (0–5000) but inside the TMA (1000–24500)
    // and FIR (0–unlimited).
    const ids = new Set(svc.currentAirspace(IST.lat, IST.lon, 10_000).map((a) => a.id));
    expect(ids).toEqual(new Set(['mock-ist-tma', 'mock-ltbb-fir']));
  });

  test('altitudeFilter=false ignores the vertical band', async () => {
    const svc = await loadedService({ altitudeFilter: false });
    const ids = new Set(svc.currentAirspace(IST.lat, IST.lon, 10_000).map((a) => a.id));
    expect(ids.has('mock-ist-ctr')).toBe(true);
  });
});

describe('AirspaceService — entry detection', () => {
  test('entering from empty reports every containing volume as entered', async () => {
    const svc = await loadedService();
    const delta = svc.detectEntry(new Set(), IST.lat, IST.lon);
    expect(new Set(delta.entered.map((a) => a.id))).toEqual(
      new Set(['mock-ist-tma', 'mock-ist-ctr', 'mock-ltbb-fir']),
    );
    expect(delta.exitedIds).toEqual([]);
    expect(delta.insideIds).toEqual(new Set(['mock-ist-tma', 'mock-ist-ctr', 'mock-ltbb-fir']));
  });

  test('re-sampling the same position enters nothing new', async () => {
    const svc = await loadedService();
    const first = svc.detectEntry(new Set(), IST.lat, IST.lon);
    const second = svc.detectEntry(first.insideIds, IST.lat, IST.lon);
    expect(second.entered).toEqual([]);
    expect(second.exitedIds).toEqual([]);
  });

  test('flying from IST to the FIR-only point exits TMA + CTR, enters nothing', async () => {
    const svc = await loadedService();
    const inside = svc.detectEntry(new Set(), IST.lat, IST.lon).insideIds;
    const delta = svc.detectEntry(inside, FIR_ONLY.lat, FIR_ONLY.lon);
    expect(delta.entered).toEqual([]);
    expect(new Set(delta.exitedIds)).toEqual(new Set(['mock-ist-tma', 'mock-ist-ctr']));
    expect(delta.insideIds).toEqual(new Set(['mock-ltbb-fir']));
  });

  test('leaving all airspace exits everything', async () => {
    const svc = await loadedService();
    const inside = svc.detectEntry(new Set(), IST.lat, IST.lon).insideIds;
    const delta = svc.detectEntry(inside, OUTSIDE.lat, OUTSIDE.lon);
    expect(delta.current).toEqual([]);
    expect(new Set(delta.exitedIds)).toEqual(inside);
    expect(delta.insideIds.size).toBe(0);
  });
});

describe('AirspaceService — load memoization', () => {
  test('load() only hits the provider once within the TTL', async () => {
    let loads = 0;
    const provider = new MockAirspaceProvider();
    const orig = provider.load.bind(provider);
    provider.load = async () => {
      loads += 1;
      await orig();
    };
    let clock = 1_000;
    const svc = new AirspaceService(provider, { loadTtlMs: 5_000, now: () => clock });
    await svc.load();
    await svc.load();
    expect(loads).toBe(1);
    clock += 10_000; // past the TTL
    await svc.load();
    expect(loads).toBe(2);
  });
});

describe('withinBand', () => {
  test('open bounds always match', () => {
    expect(withinBand(50_000, null, null)).toBe(true);
  });
  test('respects inclusive lower and upper', () => {
    expect(withinBand(1000, 1000, 5000)).toBe(true);
    expect(withinBand(5000, 1000, 5000)).toBe(true);
    expect(withinBand(999, 1000, 5000)).toBe(false);
    expect(withinBand(5001, 1000, 5000)).toBe(false);
  });
});

describe('groupByType', () => {
  test('buckets the mock dataset by kind', () => {
    const g = groupByType(MOCK_AIRSPACES);
    expect(g.fir.map((a) => a.id)).toEqual(['mock-ltbb-fir']);
    expect(new Set(g.tma.map((a) => a.id))).toEqual(new Set(['mock-ist-tma', 'mock-esb-tma']));
    expect(new Set(g.ctr.map((a) => a.id))).toEqual(new Set(['mock-ist-ctr', 'mock-esb-ctr']));
    expect(g.cta).toEqual([]);
  });
});
