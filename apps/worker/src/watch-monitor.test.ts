import { describe, expect, test } from 'bun:test';
import { createLogger } from '@flytrace/shared';
import { WatchedFlightMonitor } from './watch-monitor.ts';

const FLIGHT = '00000000-0000-7000-8000-000000000001';

describe('WatchedFlightMonitor', () => {
  test('emits lifecycle events for a watched aircraft that lands', async () => {
    const emitted: string[] = [];
    const db = {
      execute: async () => [
        {
          flightId: FLIGHT,
          callsign: 'THY123',
          source: 'adsb',
          lastPositionAt: '2026-07-19T20:00:00.000Z',
          icao24: '4bb1a2',
          lat: 41,
          lon: 29,
          altitudeFt: 900,
          headingDeg: 180,
          groundSpeedKt: 120,
          verticalRateFpm: -700,
          onGround: false,
          squawk: '7000',
          eventCount: 0,
          landingCount: 0,
          endedCount: 0,
        },
      ],
    };
    const monitor = new WatchedFlightMonitor({
      db: db as never,
      logger: createLogger({ level: 'error', base: {} }),
      emit: async (env) => {
        emitted.push(env.type);
      },
      options: {
        apiUrl: 'https://adsb.test/v2',
        intervalMs: 30_000,
        batchSize: 10,
        requestDelayMs: 0,
        maxPositionAgeMs: 90_000,
        endAfterMs: 300_000,
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ac: [
              {
                hex: '4bb1a2',
                flight: 'THY123 ',
                lat: 40.99,
                lon: 28.82,
                alt_baro: 'ground',
                gs: 8,
                track: 30,
                baro_rate: 0,
                seen_pos: 1,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        )) as unknown as typeof fetch,
    });

    expect(await monitor.runOnce()).toBe(4);
    expect(emitted).toEqual([
      'FlightDetected',
      'PositionUpdated',
      'LandingDetected',
      'FlightEnded',
    ]);
  });
});
