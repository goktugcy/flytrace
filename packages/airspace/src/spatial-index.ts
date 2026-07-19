/**
 * A simple uniform bbox-grid spatial index over loaded airspaces. Each airspace
 * is bucketed into every grid cell its bounding box overlaps; a lookup hashes
 * the query point to one cell and only runs the (expensive) point-in-geometry
 * test against candidates in that cell. This keeps `findContaining` close to
 * O(candidates-in-cell) instead of O(all-airspaces).
 *
 * Pure and in-memory — no I/O. Rebuilt whenever a provider (re)loads.
 */
import { geometryBbox, pointInGeometry } from './point-in-polygon.ts';
import type { Airspace, Bbox2D, IndexedAirspace } from './types.ts';

/** Default grid resolution in degrees (~1° ≈ 111 km). Coarse but effective. */
const DEFAULT_CELL_DEG = 1;

export interface SpatialIndexOptions {
  /** Grid cell size in degrees. Smaller = more cells, fewer candidates each. */
  cellDeg?: number;
}

export class SpatialIndex {
  private readonly cellDeg: number;
  private readonly cells = new Map<string, IndexedAirspace[]>();
  private readonly all: IndexedAirspace[] = [];

  constructor(opts: SpatialIndexOptions = {}) {
    this.cellDeg = opts.cellDeg && opts.cellDeg > 0 ? opts.cellDeg : DEFAULT_CELL_DEG;
  }

  /** Number of indexed airspaces. */
  get size(): number {
    return this.all.length;
  }

  /** All indexed airspaces, in load order. */
  list(): Airspace[] {
    return this.all.map((entry) => entry.airspace);
  }

  /** Build an index from a list of airspaces (replaces any prior contents). */
  static build(airspaces: Airspace[], opts: SpatialIndexOptions = {}): SpatialIndex {
    const idx = new SpatialIndex(opts);
    for (const a of airspaces) idx.insert(a);
    return idx;
  }

  /** Add one airspace, bucketing it into every cell its bbox overlaps. */
  insert(airspace: Airspace): void {
    const bbox = geometryBbox(airspace.polygon);
    const entry: IndexedAirspace = { airspace, bbox };
    this.all.push(entry);
    for (const key of this.cellKeysForBbox(bbox)) {
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(entry);
      else this.cells.set(key, [entry]);
    }
  }

  /**
   * Return all airspaces whose geometry contains (lon, lat). Candidates are
   * limited to the query point's grid cell, then confirmed with a precise
   * bbox + point-in-geometry test. Results are de-duplicated by airspace id.
   */
  findContaining(lat: number, lon: number): Airspace[] {
    const bucket = this.cells.get(this.cellKey(lon, lat));
    if (!bucket || bucket.length === 0) return [];
    const out: Airspace[] = [];
    const seen = new Set<string>();
    for (const { airspace, bbox } of bucket) {
      if (seen.has(airspace.id)) continue;
      if (lon < bbox[0] || lon > bbox[2] || lat < bbox[1] || lat > bbox[3]) continue;
      if (pointInGeometry(lon, lat, airspace.polygon)) {
        seen.add(airspace.id);
        out.push(airspace);
      }
    }
    return out;
  }

  private cellKey(lon: number, lat: number): string {
    const cx = Math.floor(lon / this.cellDeg);
    const cy = Math.floor(lat / this.cellDeg);
    return `${cx}:${cy}`;
  }

  private *cellKeysForBbox(bbox: Bbox2D): Iterable<string> {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const x0 = Math.floor(minLon / this.cellDeg);
    const x1 = Math.floor(maxLon / this.cellDeg);
    const y0 = Math.floor(minLat / this.cellDeg);
    const y1 = Math.floor(maxLat / this.cellDeg);
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        yield `${cx}:${cy}`;
      }
    }
  }
}
