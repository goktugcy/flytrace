import type { GeoGeometry, Position2D } from './types.ts';

const EARTH_M = 6_371_000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversineM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Course over ground a→b, degrees clockwise from north. */
export function bearingDeg(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const y = Math.sin(toRad(bLon - aLon)) * Math.cos(toRad(bLat));
  const x =
    Math.cos(toRad(aLat)) * Math.sin(toRad(bLat)) -
    Math.sin(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.cos(toRad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two headings (0–180). */
export function headingDelta(a: number, b: number): number {
  return Math.abs(((((b - a) % 360) + 540) % 360) - 180);
}

/**
 * Approximate distance (m) from a point to a segment, using a local
 * equirectangular projection — accurate at airport scale.
 */
function distToSegmentM(
  lat: number,
  lon: number,
  aLon: number,
  aLat: number,
  bLon: number,
  bLat: number,
): number {
  const cosLat = Math.cos(toRad(lat));
  const mPerDegLat = 111_320;
  const px = (lon - aLon) * mPerDegLat * cosLat;
  const py = (lat - aLat) * mPerDegLat;
  const vx = (bLon - aLon) * mPerDegLat * cosLat;
  const vy = (bLat - aLat) * mPerDegLat;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
  const dx = px - t * vx;
  const dy = py - t * vy;
  return Math.hypot(dx, dy);
}

/** Minimum distance (m) from a point to a LineString. */
export function distanceToLineStringM(lat: number, lon: number, line: Position2D[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    if (!a || !b) continue;
    min = Math.min(min, distToSegmentM(lat, lon, a[0], a[1], b[0], b[1]));
  }
  return min;
}

/** Ray-casting point-in-ring ([lon,lat] ring). */
function pointInRing(lon: number, lat: number, ring: Position2D[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point-in-polygon for GeoJSON Polygon (outer ring minus holes) / MultiPolygon. */
export function pointInGeometry(lon: number, lat: number, geom: GeoGeometry): boolean {
  if (geom.type === 'Polygon') {
    const [outer, ...holes] = geom.coordinates;
    if (!outer || !pointInRing(lon, lat, outer)) return false;
    return !holes.some((h) => pointInRing(lon, lat, h));
  }
  if (geom.type === 'MultiPolygon') {
    return geom.coordinates.some((poly) => {
      const [outer, ...holes] = poly;
      if (!outer || !pointInRing(lon, lat, outer)) return false;
      return !holes.some((h) => pointInRing(lon, lat, h));
    });
  }
  return false;
}

export type Bbox = [number, number, number, number]; // [w,s,e,n]

/** Axis-aligned bbox of any geometry (for cheap spatial pre-filtering). */
export function geometryBbox(geom: GeoGeometry): Bbox {
  let w = 180;
  let s = 90;
  let e = -180;
  let n = -90;
  const visit = (p: Position2D) => {
    w = Math.min(w, p[0]);
    e = Math.max(e, p[0]);
    s = Math.min(s, p[1]);
    n = Math.max(n, p[1]);
  };
  if (geom.type === 'Point') {
    visit(geom.coordinates);
  } else if (geom.type === 'LineString') {
    for (const p of geom.coordinates) visit(p);
  } else if (geom.type === 'Polygon') {
    for (const r of geom.coordinates) for (const p of r) visit(p);
  } else {
    for (const poly of geom.coordinates) for (const r of poly) for (const p of r) visit(p);
  }
  return [w, s, e, n];
}

export function bboxContains(b: Bbox, lon: number, lat: number, padDeg = 0): boolean {
  return (
    lon >= b[0] - padDeg && lon <= b[2] + padDeg && lat >= b[1] - padDeg && lat <= b[3] + padDeg
  );
}
