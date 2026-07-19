import type { Airspace } from '../types.ts';
/**
 * In-repo mock airspace provider — the default fallback so the tracker and the
 * `/airspace/current` API run with zero external datasets. Contains a small,
 * hand-authored set of TMA/FIR volumes around Istanbul (IST/LTFM) and Ankara
 * Esenboğa (ESB/LTAC). Shapes are simplified rectangles, adequate for local
 * development, tests, and demos — NOT for operational use.
 */
import { BaseAirspaceProvider } from './index.ts';

/** Build a rectangular Polygon airspace from a lon/lat bbox (closed ring). */
function box(
  id: string,
  name: string,
  type: Airspace['type'],
  icaoClass: string | null,
  lowerFt: number | null,
  upperFt: number | null,
  frequency: string | null,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): Airspace {
  return {
    id,
    name,
    type,
    icaoClass,
    lowerFt,
    upperFt,
    frequency,
    source: 'mock',
    polygon: {
      type: 'Polygon',
      coordinates: [
        [
          [minLon, minLat],
          [maxLon, minLat],
          [maxLon, maxLat],
          [minLon, maxLat],
          [minLon, minLat],
        ],
      ],
    },
  };
}

/** The built-in dataset. Exported so tests can assert against known volumes. */
export const MOCK_AIRSPACES: Airspace[] = [
  // Istanbul TMA — around LTFM / LTBA. Class C, SFC-band up to FL245.
  box('mock-ist-tma', 'ISTANBUL TMA', 'TMA', 'C', 1000, 24500, '121.100', 28.0, 40.5, 30.0, 41.6),
  // Istanbul CTR — tighter core zone around the field. Class D.
  box('mock-ist-ctr', 'ISTANBUL CTR', 'CTR', 'D', 0, 5000, '129.300', 28.6, 40.9, 29.2, 41.4),
  // Ankara Esenboğa TMA — around LTAC. Class C.
  box('mock-esb-tma', 'ANKARA TMA', 'TMA', 'C', 2000, 19500, '124.300', 32.0, 39.5, 33.8, 40.7),
  // Ankara Esenboğa CTR. Class D.
  box('mock-esb-ctr', 'ESENBOGA CTR', 'CTR', 'D', 0, 6000, '118.100', 32.7, 39.9, 33.3, 40.3),
  // Istanbul FIR (LTBB) — large upper CTA covering western Türkiye.
  box('mock-ltbb-fir', 'ISTANBUL FIR', 'FIR', 'A', 0, null, '135.500', 26.0, 36.0, 35.0, 43.0),
];

export class MockAirspaceProvider extends BaseAirspaceProvider {
  private readonly dataset: Airspace[];

  constructor(cellDeg?: number, dataset: Airspace[] = MOCK_AIRSPACES) {
    super(cellDeg);
    this.dataset = dataset;
  }

  protected async fetch(): Promise<Airspace[]> {
    return this.dataset;
  }
}
