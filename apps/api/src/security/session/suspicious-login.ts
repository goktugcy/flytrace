import { ipPrefix } from './ip.ts';

/**
 * Suspicious-login detection (docs §7b). All detectors are PURE and side-effect
 * free; `assessLogin` composes them into a coarse risk verdict the API layer can
 * act on (step-up MFA, email alert, silent allow). No I/O here.
 */

export type RiskLevel = 'low' | 'medium' | 'high';

export interface Geo {
  lat: number;
  lon: number;
}

export type LoginRiskReason = 'new_device' | 'new_ip_prefix' | 'impossible_travel';

/** True when `fingerprint` has not been seen among the user's known devices. */
export function isNewDevice(known: readonly string[], fingerprint: string): boolean {
  return !known.includes(fingerprint);
}

/**
 * True when `ip` falls outside every known network prefix (/24 v4, /48 v6).
 * Comparing prefixes (not exact IPs) avoids false alarms from normal address
 * churn within the same ISP/network.
 */
export function isNewIpPrefix(
  knownIps: readonly string[],
  ip: string,
  v4bits = 24,
  v6bits = 48,
): boolean {
  const target = ipPrefix(ip, v4bits, v6bits);
  return !knownIps.some((k) => ipPrefix(k, v4bits, v6bits) === target);
}

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(a: Geo, b: Geo): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * True when travelling from `prevGeo`@`prevTs` to `newGeo`@`newTs` would require
 * exceeding `maxKmh`. Timestamps are epoch-ms. Non-positive elapsed time with a
 * meaningful move (>1km) is impossible by definition.
 */
export function impossibleTravel(
  prevGeo: Geo,
  prevTs: number,
  newGeo: Geo,
  newTs: number,
  maxKmh: number,
): boolean {
  const distKm = haversineKm(prevGeo, newGeo);
  const elapsedH = (newTs - prevTs) / 3_600_000;
  if (elapsedH <= 0) return distKm > 1;
  return distKm / elapsedH > maxKmh;
}

export interface LoginAssessmentContext {
  fingerprint: string;
  knownFingerprints: readonly string[];
  ip: string;
  knownIps: readonly string[];
  /** Optional travel check — omit when there is no prior geolocated login. */
  travel?: { prevGeo: Geo; prevTs: number; newGeo: Geo; newTs: number; maxKmh: number } | undefined;
  v4bits?: number | undefined;
  v6bits?: number | undefined;
}

export interface LoginAssessment {
  risk: RiskLevel;
  reasons: LoginRiskReason[];
}

/**
 * Compose the pure detectors into a risk verdict:
 *   - impossible travel               → high
 *   - new device AND new ip prefix    → high
 *   - any single signal               → medium
 *   - nothing                         → low
 */
export function assessLogin(ctx: LoginAssessmentContext): LoginAssessment {
  const reasons: LoginRiskReason[] = [];
  if (isNewDevice(ctx.knownFingerprints, ctx.fingerprint)) reasons.push('new_device');
  if (isNewIpPrefix(ctx.knownIps, ctx.ip, ctx.v4bits, ctx.v6bits)) reasons.push('new_ip_prefix');
  if (
    ctx.travel &&
    impossibleTravel(
      ctx.travel.prevGeo,
      ctx.travel.prevTs,
      ctx.travel.newGeo,
      ctx.travel.newTs,
      ctx.travel.maxKmh,
    )
  ) {
    reasons.push('impossible_travel');
  }

  let risk: RiskLevel = 'low';
  if (reasons.includes('impossible_travel')) {
    risk = 'high';
  } else if (reasons.includes('new_device') && reasons.includes('new_ip_prefix')) {
    risk = 'high';
  } else if (reasons.length > 0) {
    risk = 'medium';
  }

  return { risk, reasons };
}
