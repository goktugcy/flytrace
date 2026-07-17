import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { createHotState } from './hot-state.ts';

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

function seed(r: FakeRedis, id: string, lat: number, lon: number, airborne = true): void {
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
      airborne,
      lastTs: '2023-11-14T22:13:20.000Z',
    }),
  );
}

describe('createHotState', () => {
  test('lists all live flights and maps fields', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29, false);
    const hot = createHotState(r as unknown as Redis, PREFIX);
    const live = await hot.live();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      flightId: 'F1',
      altitudeFt: 30000,
      groundSpeedKt: 450,
      onGround: true, // airborne=false → onGround
    });
  });

  test('filters to the bbox', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29); // inside
    seed(r, 'F2', 10, 10); // outside
    const hot = createHotState(r as unknown as Redis, PREFIX);
    const live = await hot.live([28, 40, 33, 42]);
    expect(live.map((f) => f.flightId)).toEqual(['F1']);
  });

  test('count reflects the active set', async () => {
    const r = new FakeRedis();
    seed(r, 'F1', 41, 29);
    seed(r, 'F2', 41, 30);
    const hot = createHotState(r as unknown as Redis, PREFIX);
    expect(await hot.count()).toBe(2);
  });

  test('empty when no active flights', async () => {
    const hot = createHotState(new FakeRedis() as unknown as Redis, PREFIX);
    expect(await hot.live()).toEqual([]);
    expect(await hot.count()).toBe(0);
  });
});
