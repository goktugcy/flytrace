/**
 * Pure position-array downsamplers used to keep track payloads small before
 * they leave the DB layer (charts, map trails, long-term storage). No DB, no
 * I/O — just array→array transforms, so they're fully unit-testable.
 *
 *  - `downsampleByTime`  — keep at most one representative sample per time
 *                          bucket (used for altitude/speed history charts).
 *  - `simplifyTrail`     — Douglas–Peucker-lite line simplification: drop points
 *                          that lie within `tolerance` of the retained polyline,
 *                          preserving the shape of the ground track with far
 *                          fewer vertices.
 */

/** Minimal timestamped sample; `ts` may be epoch ms or an ISO/Date string. */
export interface TimedSample {
  ts: number | string | Date;
}

/** A lat/lon point on a ground track (plus a timestamp for ordering). */
export interface TrailPoint extends TimedSample {
  lat: number;
  lon: number;
}

/** Coerce a ts value (epoch ms, ISO string, or Date) to epoch milliseconds. */
export function toEpochMs(ts: number | string | Date): number {
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts).getTime();
}

/**
 * Keep one sample per fixed-width time bucket. Points are assumed ascending by
 * time; the LAST point seen in each bucket wins (most-recent value for the
 * interval). Returns a new array in ascending bucket order.
 *
 * @param bucketMs bucket width in milliseconds (must be > 0).
 */
export function downsampleByTime<T extends TimedSample>(
  points: readonly T[],
  bucketMs: number,
): T[] {
  if (bucketMs <= 0) throw new Error(`downsampleByTime: bucketMs must be > 0, got ${bucketMs}`);
  if (points.length <= 1) return [...points];

  const out: T[] = [];
  let currentBucket: number | null = null;
  for (const p of points) {
    const bucket = Math.floor(toEpochMs(p.ts) / bucketMs);
    if (bucket === currentBucket) {
      // Same bucket → replace with the later sample.
      out[out.length - 1] = p;
    } else {
      out.push(p);
      currentBucket = bucket;
    }
  }
  return out;
}

/**
 * Perpendicular distance from point `p` to the line through `a`→`b`, computed
 * in an equirectangular (planar) approximation of lat/lon degrees. Adequate for
 * simplification at flight-track scales; not a geodesic distance.
 */
function perpendicularDistance(p: TrailPoint, a: TrailPoint, b: TrailPoint): number {
  // Scale longitude by cos(lat) so degrees are roughly isotropic near the line.
  const latRad = (a.lat * Math.PI) / 180;
  const kx = Math.cos(latRad);
  const ax = a.lon * kx;
  const ay = a.lat;
  const bx = b.lon * kx;
  const by = b.lat;
  const px = p.lon * kx;
  const py = p.lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    // a and b coincide → distance to the point.
    return Math.hypot(px - ax, py - ay);
  }
  // Distance from point to the infinite line through a,b.
  const cross = Math.abs(dy * px - dx * py + bx * ay - by * ax);
  return cross / Math.sqrt(lenSq);
}

/**
 * Douglas–Peucker-lite simplification of a lat/lon trail. Endpoints are always
 * kept; interior points within `tolerance` (in approximate degrees) of the
 * retained segment are dropped. Returns points in their original order.
 *
 * @param tolerance max allowed perpendicular deviation (degrees); larger =
 * fewer points. Must be >= 0; 0 or a ≤2-point input returns the input as-is.
 */
export function simplifyTrail(points: readonly TrailPoint[], tolerance: number): TrailPoint[] {
  if (tolerance <= 0 || points.length <= 2) return [...points];

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;

  // Iterative stack-based RDP to avoid deep recursion on long tracks.
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop() as [number, number];
    if (end - start < 2) continue;

    let maxDist = -1;
    let maxIdx = -1;
    const a = points[start] as TrailPoint;
    const b = points[end] as TrailPoint;
    for (let i = start + 1; i < end; i += 1) {
      const dist = perpendicularDistance(points[i] as TrailPoint, a, b);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance && maxIdx > start) {
      keep[maxIdx] = true;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  return points.filter((_, i) => keep[i]);
}
