import { describe, expect, test } from 'bun:test';
import type { AirportFeature, GroundObs } from '@flytrace/airport-ops';
import { createAirportGroundService } from './airport-ground-service.ts';

const features: AirportFeature[] = [
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
];

function svc() {
  return createAirportGroundService({
    listAirports: async () => [{ airportId: 'a1', icao: 'LTFM', lat: 41.0, lon: 29.0 }],
    loadFeatures: async () => features,
  });
}

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

describe('AirportGroundService', () => {
  test('preloads airports that have geometry', async () => {
    expect((await svc()).airportCount).toBe(1);
  });

  test('classifies a taxiing aircraft near the airport and flags the change', async () => {
    const s = await svc();
    const res = s.process('abc123', obs({ lon: 29.005, gsKt: 15 }));
    expect(res).not.toBeNull();
    expect(res?.airportIcao).toBe('LTFM');
    expect(res?.state).toBe('TAXI_OUT');
    expect(res?.changed).toBe(true);
    // Same state again → no change event.
    expect(s.process('abc123', obs({ lon: 29.006, gsKt: 15, tsMs: 5000 }))?.changed).toBe(false);
  });

  test('ignores cruising aircraft and aircraft far from any airport', async () => {
    const s = await svc();
    expect(s.process('hi', obs({ altFt: 35_000, onGround: false, lon: 29.005 }))).toBeNull();
    expect(s.process('far', obs({ lat: 45, lon: 40, altFt: 500 }))).toBeNull();
  });
});
