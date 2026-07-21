import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_FLIGHT_MOTION_CONFIG,
  angleDelta,
  bearingDeg,
  distanceNm,
  projectFlightSample,
  stepRenderedFlight,
} from './flight-motion';
import type { FlightSample } from './flight-store';

const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z');

function sample(over: Partial<FlightSample> = {}): FlightSample {
  return {
    flightId: 'F1',
    icao24: 'abc123',
    callsign: 'THY1',
    lat: 41,
    lon: 29,
    heading: 90,
    altFt: 30000,
    geoAltitudeFt: null,
    gsKt: 360,
    verticalRateFpm: null,
    onGround: false,
    squawk: null,
    category: 'jet',
    source: null,
    sourceTimestamp: null,
    ageMs: null,
    qualityScore: null,
    positionSource: null,
    isMlat: null,
    qualityState: 'live',
    receivedAtMs: BASE_MS,
    connectionGeneration: 1,
    ts: new Date(BASE_MS).toISOString(),
    tsMs: BASE_MS,
    ...over,
  };
}

describe('flight motion helpers', () => {
  test('angleDelta uses the shortest heading turn', () => {
    expect(angleDelta(359, 1)).toBe(2);
    expect(angleDelta(1, 359)).toBe(-2);
  });

  test('projects a live airborne sample for at most 15 seconds', () => {
    const f = sample({ heading: 90, gsKt: 600 });
    const at15 = projectFlightSample(f, BASE_MS + 15_000);
    const at20 = projectFlightSample(f, BASE_MS + 20_000);

    expect(distanceNm(f.lat, f.lon, at15[0], at15[1])).toBeCloseTo(2.5, 1);
    expect(distanceNm(f.lat, f.lon, at20[0], at20[1])).toBeCloseTo(
      distanceNm(f.lat, f.lon, at15[0], at15[1]),
      4,
    );
  });

  test('does not project stale or signal-lost samples', () => {
    const stale = sample({ tsMs: BASE_MS - 31_000, ts: new Date(BASE_MS - 31_000).toISOString() });
    const signalLost = sample({
      tsMs: BASE_MS - 61_000,
      ts: new Date(BASE_MS - 61_000).toISOString(),
    });
    const serverStale = sample({ qualityState: 'stale' });
    const serverSignalLost = sample({ qualityState: 'signal_lost' });

    expect(projectFlightSample(stale, BASE_MS)).toEqual([stale.lat, stale.lon]);
    expect(projectFlightSample(signalLost, BASE_MS)).toEqual([signalLost.lat, signalLost.lon]);
    expect(projectFlightSample(serverStale, BASE_MS + 1_000)).toEqual([
      serverStale.lat,
      serverStale.lon,
    ]);
    expect(projectFlightSample(serverSignalLost, BASE_MS + 1_000)).toEqual([
      serverSignalLost.lat,
      serverSignalLost.lon,
    ]);
  });

  test('eases small corrections between rendered and verified positions', () => {
    const f = sample({ lat: 41.1, lon: 29.1, heading: 1 });
    const next = stepRenderedFlight({ lat: 41, lon: 29, hdg: 359 }, f, BASE_MS, {
      ...DEFAULT_FLIGHT_MOTION_CONFIG,
      lerp: 0.5,
      deadReckonLiveMs: 0,
    });

    expect(next.lat).toBeCloseTo(41.05, 6);
    expect(next.lon).toBeCloseTo(29.05, 6);
    expect(next.hdg).toBeCloseTo(360, 6);
  });

  test('derives the icon heading from movement when ADS-B track is missing', () => {
    // No heading reported, but the aircraft has clearly moved east → course ≈ 90°.
    const f = sample({ heading: null, lat: 41, lon: 29.05 });
    const next = stepRenderedFlight({ lat: 41, lon: 29, hdg: 0 }, f, BASE_MS, {
      ...DEFAULT_FLIGHT_MOTION_CONFIG,
      lerp: 1,
      deadReckonLiveMs: 0,
    });
    expect(next.hdg).toBeCloseTo(90, 0);
  });

  test('keeps the last heading when track is missing and the aircraft is stationary', () => {
    const f = sample({ heading: null, lat: 41, lon: 29 });
    const next = stepRenderedFlight({ lat: 41, lon: 29, hdg: 215 }, f, BASE_MS, {
      ...DEFAULT_FLIGHT_MOTION_CONFIG,
      lerp: 1,
      deadReckonLiveMs: 0,
    });
    expect(next.hdg).toBe(215);
  });

  test('bearingDeg computes course over ground', () => {
    expect(bearingDeg(41, 29, 41, 30)).toBeCloseTo(90, 0); // due east
    expect(bearingDeg(41, 29, 42, 29)).toBeCloseTo(0, 6); // due north
  });

  test('snaps instead of animating implausibly large corrections', () => {
    const f = sample({ lat: 42, lon: 35, heading: 270 });
    const next = stepRenderedFlight({ lat: 41, lon: 29, hdg: 90 }, f, BASE_MS, {
      ...DEFAULT_FLIGHT_MOTION_CONFIG,
      deadReckonLiveMs: 0,
      snapDistanceNm: 10,
    });

    expect(next).toEqual({ lat: 42, lon: 35, hdg: 270 });
  });
});
