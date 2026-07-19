import {
  CLIENT_FLIGHT_LIFECYCLE,
  type FlightLifecycleConfig,
  type FlightQualityState,
  type FlightSample,
  classifyFlightSample,
} from './flight-store';

export interface RenderedFlight {
  lat: number;
  lon: number;
  hdg: number;
}

export interface FlightMotionConfig {
  deadReckonLiveMs: number;
  deadReckonDelayedMs: number;
  lerp: number;
  snapDistanceNm: number;
  lifecycle: FlightLifecycleConfig;
}

export const DEFAULT_FLIGHT_MOTION_CONFIG: FlightMotionConfig = {
  deadReckonLiveMs: 15_000,
  deadReckonDelayedMs: 15_000,
  lerp: 0.16,
  snapDistanceNm: 25,
  lifecycle: CLIENT_FLIGHT_LIFECYCLE,
};

const KT_TO_MS = 0.514_444;
const M_PER_DEG_LAT = 111_320;
const EARTH_RADIUS_NM = 3440.065;
const QUALITY_RANK: Record<FlightQualityState, number> = {
  live: 0,
  delayed: 1,
  stale: 2,
  signal_lost: 3,
};

/** Shortest signed angular delta from a to b in degrees. */
export function angleDelta(a: number, b: number): number {
  return ((((b - a) % 360) + 540) % 360) - 180;
}

export function projectFlightSample(
  f: FlightSample,
  nowMs: number,
  config: FlightMotionConfig = DEFAULT_FLIGHT_MOTION_CONFIG,
): [lat: number, lon: number] {
  if (f.onGround || !f.gsKt || f.heading == null) return [f.lat, f.lon];
  const quality = qualityForMotion(f, nowMs, config.lifecycle);
  if (quality === 'stale' || quality === 'signal_lost') return [f.lat, f.lon];

  const capMs = quality === 'delayed' ? config.deadReckonDelayedMs : config.deadReckonLiveMs;
  const dt = Math.min(Math.max(nowMs - f.tsMs, 0), capMs) / 1000;
  if (dt === 0) return [f.lat, f.lon];

  const dist = f.gsKt * KT_TO_MS * dt;
  const brng = toRad(f.heading);
  const dLat = (dist * Math.cos(brng)) / M_PER_DEG_LAT;
  const cosLat = Math.cos(toRad(f.lat));
  const dLon = Math.abs(cosLat) < 1e-6 ? 0 : (dist * Math.sin(brng)) / (M_PER_DEG_LAT * cosLat);
  return [f.lat + dLat, f.lon + dLon];
}

export function stepRenderedFlight(
  prev: RenderedFlight | undefined,
  f: FlightSample,
  nowMs: number,
  config: FlightMotionConfig = DEFAULT_FLIGHT_MOTION_CONFIG,
): RenderedFlight {
  const [targetLat, targetLon] = projectFlightSample(f, nowMs, config);
  const targetHdg = f.heading ?? prev?.hdg ?? 0;

  if (!prev) return { lat: targetLat, lon: targetLon, hdg: targetHdg };
  if (distanceNm(prev.lat, prev.lon, targetLat, targetLon) > config.snapDistanceNm) {
    return { lat: targetLat, lon: targetLon, hdg: targetHdg };
  }

  const lerp = Math.max(0, Math.min(1, config.lerp));
  return {
    lat: prev.lat + (targetLat - prev.lat) * lerp,
    lon: prev.lon + (targetLon - prev.lon) * lerp,
    hdg: prev.hdg + angleDelta(prev.hdg, targetHdg) * lerp,
  };
}

export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function qualityForMotion(
  sample: Pick<FlightSample, 'qualityState' | 'tsMs'>,
  nowMs: number,
  lifecycle: FlightLifecycleConfig,
): FlightQualityState {
  const byAge = classifyFlightSample(sample, nowMs, lifecycle);
  return QUALITY_RANK[sample.qualityState] > QUALITY_RANK[byAge] ? sample.qualityState : byAge;
}
