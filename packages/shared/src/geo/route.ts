export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface RoutePosition extends GeoPoint {
  headingDeg?: number | null | undefined;
  onGround?: boolean | undefined;
}

/** Reject route metadata that conflicts with the current corridor or direction. */
export function routeMatchesPosition(
  origin: GeoPoint,
  destination: GeoPoint,
  position: RoutePosition,
): boolean {
  const legNm = distanceNm(origin, destination);
  const originNm = distanceNm(origin, position);
  const destinationNm = distanceNm(position, destination);
  const excessNm = originNm + destinationNm - legNm;
  const corridorNm = Math.max(90, Math.min(650, legNm * 0.18));
  if (excessNm > corridorNm) return false;

  if (position.onGround || position.headingDeg == null) return true;
  if (originNm < 60 || destinationNm < 60) return true;
  return headingDifference(position.headingDeg, bearingDeg(position, destination)) <= 120;
}

function distanceNm(a: GeoPoint, b: GeoPoint): number {
  const earthRadiusNm = 3440.065;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusNm * Math.asin(Math.min(1, Math.sqrt(value)));
}

function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const fromLat = toRad(a.lat);
  const toLat = toRad(b.lat);
  const dLon = toRad(b.lon - a.lon);
  const y = Math.sin(dLon) * Math.cos(toLat);
  const x =
    Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function headingDifference(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}
