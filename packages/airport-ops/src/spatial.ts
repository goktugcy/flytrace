import {
  type Bbox,
  bboxContains,
  distanceToLineStringM,
  geometryBbox,
  haversineM,
  pointInGeometry,
} from './geo.ts';
import type { AeroFeatureKind, AirportFeature, GeoGeometry, Position2D } from './types.ts';

interface LineFeat {
  ref: string | null;
  name: string | null;
  line: Position2D[];
  bbox: Bbox;
}
interface AreaFeat {
  kind: AeroFeatureKind;
  ref: string | null;
  name: string | null;
  geom: GeoGeometry;
  bbox: Bbox;
}
interface PointFeat {
  ref: string | null;
  name: string | null;
  lat: number;
  lon: number;
}

export interface NearestResult {
  ref: string | null;
  name: string | null;
  distM: number;
}

/**
 * In-memory index of one airport's ground geometry, built once from the DB rows
 * and queried per position (no DB round-trip per observation). Airports have a
 * few hundred features, so a bbox-prefiltered linear scan is plenty; queries
 * only run for aircraft already near the airport.
 */
export class AirportGroundIndex {
  private readonly gates: PointFeat[] = [];
  private readonly runways: LineFeat[] = [];
  private readonly taxiways: LineFeat[] = [];
  private readonly areas: AreaFeat[] = []; // apron / terminal / hangar / parking polygons

  constructor(features: AirportFeature[]) {
    for (const f of features) {
      const g = f.geojson;
      if (!g) continue;
      if (f.kind === 'gate' || f.kind === 'parking') {
        const p = representativePoint(g);
        if (p) this.gates.push({ ref: f.ref, name: f.name, lon: p[0], lat: p[1] });
      } else if (f.kind === 'runway' && g.type === 'LineString') {
        this.runways.push({ ref: f.ref, name: f.name, line: g.coordinates, bbox: geometryBbox(g) });
      } else if (f.kind === 'taxiway' && g.type === 'LineString') {
        this.taxiways.push({
          ref: f.ref,
          name: f.name,
          line: g.coordinates,
          bbox: geometryBbox(g),
        });
      } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
        this.areas.push({ kind: f.kind, ref: f.ref, name: f.name, geom: g, bbox: geometryBbox(g) });
      }
    }
  }

  get isEmpty(): boolean {
    return (
      this.gates.length === 0 &&
      this.runways.length === 0 &&
      this.taxiways.length === 0 &&
      this.areas.length === 0
    );
  }

  nearestGate(lat: number, lon: number): NearestResult | null {
    let best: NearestResult | null = null;
    for (const gt of this.gates) {
      const distM = haversineM(lat, lon, gt.lat, gt.lon);
      if (!best || distM < best.distM) best = { ref: gt.ref, name: gt.name, distM };
    }
    return best;
  }

  private nearestLine(lines: LineFeat[], lat: number, lon: number): NearestResult | null {
    let best: NearestResult | null = null;
    for (const l of lines) {
      if (!bboxContains(l.bbox, lon, lat, 0.03)) continue; // ~3 km pad prefilter
      const distM = distanceToLineStringM(lat, lon, l.line);
      if (!best || distM < best.distM) best = { ref: l.ref, name: l.name, distM };
    }
    return best;
  }

  nearestRunway(lat: number, lon: number): NearestResult | null {
    return this.nearestLine(this.runways, lat, lon);
  }

  nearestTaxiway(lat: number, lon: number): NearestResult | null {
    return this.nearestLine(this.taxiways, lat, lon);
  }

  /** The most specific polygon kind containing the point, or null. */
  containingArea(lat: number, lon: number): AeroFeatureKind | null {
    for (const a of this.areas) {
      if (!bboxContains(a.bbox, lon, lat)) continue;
      if (pointInGeometry(lon, lat, a.geom)) return a.kind;
    }
    return null;
  }
}

function representativePoint(g: GeoGeometry): Position2D | null {
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon') return ringCentroid(g.coordinates[0]);
  if (g.type === 'MultiPolygon') return ringCentroid(g.coordinates[0]?.[0]);
  return g.coordinates[Math.floor(g.coordinates.length / 2)] ?? null; // LineString mid-point
}

function ringCentroid(ring?: Position2D[]): Position2D | null {
  if (!ring || ring.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}
