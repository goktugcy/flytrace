import { describe, expect, test } from 'bun:test';
import { AirportGroundIndex } from './spatial.ts';
import { initialGroundTrack, stepGroundState } from './state-machine.ts';
import type { AirportFeature, GroundObs, GroundTrack } from './types.ts';

// A tiny synthetic airport: a gate, a taxiway running east to the runway
// threshold, a north–south runway, and an apron polygon around the gate.
const features: AirportFeature[] = [
  {
    id: 'g1',
    kind: 'gate',
    ref: 'A1',
    name: null,
    geojson: { type: 'Point', coordinates: [29.0, 41.0] },
  },
  {
    id: 't1',
    kind: 'taxiway',
    ref: 'T',
    name: null,
    geojson: {
      type: 'LineString',
      coordinates: [
        [29.0, 41.0],
        [29.0095, 41.0],
      ],
    },
  },
  {
    id: 'r1',
    kind: 'runway',
    ref: '18/36',
    name: null,
    geojson: {
      type: 'LineString',
      coordinates: [
        [29.01, 40.995],
        [29.01, 41.005],
      ],
    },
  },
  {
    id: 'ap',
    kind: 'apron',
    ref: null,
    name: null,
    geojson: {
      type: 'Polygon',
      coordinates: [
        [
          [28.999, 40.999],
          [29.001, 40.999],
          [29.001, 41.001],
          [28.999, 41.001],
          [28.999, 40.999],
        ],
      ],
    },
  },
];

const idx = new AirportGroundIndex(features);

function obs(over: Partial<GroundObs>): GroundObs {
  return {
    lat: 41.0,
    lon: 29.0,
    altFt: 0,
    gsKt: 0,
    verticalRateFpm: 0,
    headingDeg: 90,
    onGround: true,
    tsMs: 0,
    ...over,
  };
}

describe('AirportGroundIndex', () => {
  test('locates gates, runways, taxiways and apron', () => {
    expect(idx.nearestGate(41.0, 29.0)?.distM).toBeLessThan(5);
    expect(idx.nearestRunway(41.0, 29.01)?.distM).toBeLessThan(5);
    expect(idx.nearestTaxiway(41.0, 29.005)?.distM).toBeLessThan(5);
    expect(idx.containingArea(41.0, 29.0)).toBe('apron');
    expect(idx.containingArea(41.0, 29.5)).toBeNull();
  });
});

describe('stepGroundState — departure sequence', () => {
  test('AT_GATE → PUSHBACK → TAXI_OUT → HOLD_SHORT → LINE_UP → TAKEOFF_ROLL → AIRBORNE', () => {
    let track: GroundTrack = initialGroundTrack(obs({ tsMs: 0 }));

    const run = (o: Partial<GroundObs>): string => {
      track = stepGroundState(track, obs(o), idx).track;
      return track.state;
    };

    // Stationary at the gate long enough to satisfy the 3-min dwell.
    run({ tsMs: 0, gsKt: 0 });
    expect(run({ tsMs: 200_000, gsKt: 0 })).toBe('AT_GATE');
    // Creep off the gate at 2.5 kt (above parked, below taxi) → pushback.
    expect(run({ tsMs: 210_000, lon: 29.001, gsKt: 2.5, headingDeg: 120 })).toBe('PUSHBACK');
    // Roll along the taxiway at 15 kt.
    expect(run({ tsMs: 230_000, lon: 29.005, gsKt: 15 })).toBe('TAXI_OUT');
    // Reach the taxiway end near the runway threshold, slow → hold short.
    expect(run({ tsMs: 260_000, lon: 29.0095, gsKt: 1 })).toBe('HOLD_SHORT');
    // Line up on the runway.
    expect(run({ tsMs: 275_000, lon: 29.01, gsKt: 3 })).toBe('LINE_UP');
    // Accelerate → takeoff roll.
    expect(run({ tsMs: 285_000, lon: 29.01, gsKt: 90 })).toBe('TAKEOFF_ROLL');
    // Lift off.
    expect(run({ tsMs: 295_000, lon: 29.011, gsKt: 150, onGround: false, altFt: 300 })).toBe(
      'AIRBORNE',
    );
    expect(track.everAirborne).toBe(true);
  });

  test('arrival taxi is TAXI_IN, not TAXI_OUT', () => {
    // Seed a track that has already flown + landed.
    let track: GroundTrack = {
      state: 'LANDING',
      sinceMs: 0,
      atMs: 0,
      gateRef: null,
      runwayRef: '18/36',
      lastHeadingDeg: 90,
      lastGsKt: 40,
      everAirborne: true,
      gateStationarySinceMs: null,
    };
    track = stepGroundState(track, obs({ tsMs: 10_000, lon: 29.005, gsKt: 15 }), idx).track;
    expect(track.state).toBe('TAXI_IN');
  });
});
