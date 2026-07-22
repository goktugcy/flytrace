export interface TrailPoint {
  ts: string;
  lat: number | null;
  lon: number | null;
}

export interface TrailAnchor {
  ts: string;
  lat: number;
  lon: number;
}

const MAX_INTERNAL_GAP_MS = 10 * 60_000;
const MAX_ANCHOR_GAP_MS = 20 * 60_000;
const MAX_AIRCRAFT_SPEED_KT = 750;
const MIN_POINT_DISTANCE_NM = 0.04;

/** Return only the latest physically continuous segment that reaches the live aircraft. */
export function contiguousTrailToAnchor(
  points: TrailPoint[],
  anchor: TrailAnchor,
): [number, number][] {
  const valid = points
    .flatMap((point) => {
      const tsMs = parseTrackTimeMs(point.ts);
      if (tsMs == null || point.lat == null || point.lon == null) return [];
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) return [];
      return [{ tsMs, lat: point.lat, lon: point.lon }];
    })
    .sort((a, b) => a.tsMs - b.tsMs);
  const anchorTsMs = parseTrackTimeMs(anchor.ts);
  if (valid.length === 0 || anchorTsMs == null) return [];

  let segment: typeof valid = [];
  for (const point of valid) {
    const previous = segment[segment.length - 1];
    if (!previous) {
      segment = [point];
      continue;
    }
    const elapsedMs = point.tsMs - previous.tsMs;
    const distanceNm = haversineNm(previous, point);
    if (
      elapsedMs <= 0 ||
      elapsedMs > MAX_INTERNAL_GAP_MS ||
      requiredSpeedKt(distanceNm, elapsedMs) > MAX_AIRCRAFT_SPEED_KT
    ) {
      segment = [point];
      continue;
    }
    if (distanceNm >= MIN_POINT_DISTANCE_NM) segment.push(point);
  }

  const last = segment[segment.length - 1];
  if (!last) return [];
  const anchorGapMs = anchorTsMs - last.tsMs;
  const anchorDistanceNm = haversineNm(last, anchor);
  if (anchorGapMs < -2 * 60_000 || anchorGapMs > MAX_ANCHOR_GAP_MS) return [];
  if (requiredSpeedKt(anchorDistanceNm, Math.max(anchorGapMs, 1)) > MAX_AIRCRAFT_SPEED_KT)
    return [];

  const coords = segment.map((point) => [point.lon, point.lat] as [number, number]);
  if (anchorDistanceNm >= MIN_POINT_DISTANCE_NM) coords.push([anchor.lon, anchor.lat]);
  return coords.length >= 2 ? coords : [];
}

export function parseTrackTimeMs(raw: string): number | null {
  const withT = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const normalized = withT.replace(/([+-]\d{2})$/, '$1:00');
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

function requiredSpeedKt(distanceNm: number, elapsedMs: number): number {
  if (distanceNm < MIN_POINT_DISTANCE_NM) return 0;
  if (elapsedMs <= 0) return Number.POSITIVE_INFINITY;
  return distanceNm / (elapsedMs / 3_600_000);
}

function haversineNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radiusNm = 3440.065;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusNm * Math.asin(Math.min(1, Math.sqrt(value)));
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
