/**
 * Pure geometric primitives for airspace containment. Everything here is a
 * deterministic function of its inputs (no I/O), so it is fully unit-testable.
 *
 * Coordinate order is GeoJSON [lon, lat] throughout (RFC 7946). We treat the
 * plane as flat: airspace volumes are small enough that a planar ray-cast is
 * accurate for containment, and it avoids great-circle cost on the hot path.
 */
import type {
  AirspaceGeometry,
  Bbox2D,
  GeoJsonMultiPolygon,
  GeoJsonPolygon,
  LinearRing,
  Position2D,
} from './types.ts';

/**
 * Ray-casting point-in-ring test (even-odd rule). Counts how many times a ray
 * cast east from the point crosses the ring's edges; odd ⇒ inside. Points
 * exactly on an edge are treated as inside (boundary-inclusive), which is the
 * desired behaviour for airspace entry.
 */
export function pointInRing(lon: number, lat: number, ring: LinearRing): boolean {
  let inside = false;
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = ring[i] as Position2D;
    const b = ring[j] as Position2D;
    const xi = a[0];
    const yi = a[1];
    const xj = b[0];
    const yj = b[1];

    // Exact boundary: point lies on this edge → inside.
    if (pointOnSegment(lon, lat, xi, yi, xj, yj)) return true;

    const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True when (px,py) lies on the closed segment (x1,y1)-(x2,y2), within eps. */
function pointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  eps = 1e-12,
): boolean {
  // Collinearity via cross product ≈ 0.
  const cross = (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  if (Math.abs(cross) > eps) return false;
  // Within the segment's bounding box (with a tiny tolerance).
  const minX = Math.min(x1, x2) - eps;
  const maxX = Math.max(x1, x2) + eps;
  const minY = Math.min(y1, y2) - eps;
  const maxY = Math.max(y1, y2) + eps;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/**
 * Point-in-polygon with holes: inside the outer ring AND outside every hole.
 * `polygon` is a GeoJSON Polygon coordinate array (ring[0] = outer).
 */
export function pointInPolygonRings(lon: number, lat: number, rings: LinearRing[]): boolean {
  if (rings.length === 0) return false;
  const outer = rings[0] as LinearRing;
  if (!pointInRing(lon, lat, outer)) return false;
  for (let i = 1; i < rings.length; i += 1) {
    if (pointInRing(lon, lat, rings[i] as LinearRing)) return false; // in a hole
  }
  return true;
}

/** Point-in-geometry for Polygon or MultiPolygon, with a bbox pre-check. */
export function pointInGeometry(lon: number, lat: number, geometry: AirspaceGeometry): boolean {
  const bbox = geometryBbox(geometry);
  if (!pointInBbox(lon, lat, bbox)) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lon, lat, (geometry as GeoJsonPolygon).coordinates);
  }
  for (const poly of (geometry as GeoJsonMultiPolygon).coordinates) {
    if (pointInPolygonRings(lon, lat, poly)) return true;
  }
  return false;
}

/** Fast inclusive bounding-box membership test. */
export function pointInBbox(lon: number, lat: number, bbox: Bbox2D): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/** Compute the [minLon, minLat, maxLon, maxLat] bbox of a geometry. */
export function geometryBbox(geometry: AirspaceGeometry): Bbox2D {
  let minLon = Number.POSITIVE_INFINITY;
  let minLat = Number.POSITIVE_INFINITY;
  let maxLon = Number.NEGATIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;

  const scan = (ring: LinearRing): void => {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
    }
  };

  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) scan(ring);
  } else {
    for (const poly of geometry.coordinates) for (const ring of poly) scan(ring);
  }
  return [minLon, minLat, maxLon, maxLat];
}
