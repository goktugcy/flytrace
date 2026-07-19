/**
 * The hot, per-flight state the tracker diffs against to derive events
 * (docs/09 §9.8). Rebuildable from Postgres if Redis is lost; never the source
 * of truth. Kept deliberately small and JSON-serializable (Redis hash value).
 */

import type {
  ObservationRejectionDebug,
  ObservationRejectionReason,
  ProviderCandidateDebug,
} from './observation-debug.ts';

export type VerticalMachineState = 'climb' | 'level' | 'descent';
export type FlightQualityState = 'live' | 'delayed' | 'stale' | 'signal_lost';

export interface FlightTransitionDebug {
  at: string;
  from?: FlightQualityState;
  to: FlightQualityState | 'ended';
  ageMs?: number;
  reason?: string;
  sequence: number;
}

export interface FlightState {
  flightId: string;
  icao24: string;
  callsign: string | null;

  // last accepted sample
  lat: number;
  lon: number;
  altFt: number | null;
  vrateFpm: number | null;
  gsKt: number | null;
  headingDeg: number | null;
  /** Coarse aircraft class (light | jet | heavy | helo) for map iconography. */
  category: string | null;
  lastTs: string; // ISO of the last accepted sample
  /**
   * Realtime freshness state derived from the age of the last accepted sample.
   * Optional for backward compatibility with Redis hot states written before
   * this field existed; newly written states always include it.
   */
  qualityState?: FlightQualityState;
  /** Wall/event clock ISO when the tracker accepted the latest sample. */
  lastAcceptedAt?: string;
  /** Clock ISO when qualityState last changed. */
  lastQualityTransitionAt?: string;
  /** Monotonic index of quality transitions (idempotency keys). */
  lifecycleSeq?: number;
  /** Monotonic accepted-position sequence for debugging/reconciliation. */
  sequence?: number;
  /** Position provider selected for the latest accepted sample. */
  selectedProvider?: string;
  candidateProviders?: string[];
  providerCandidates?: ProviderCandidateDebug[];
  sourceTimestamp?: string;
  receivedAt?: string;
  ageMs?: number;
  lastRejectedAt?: string;
  rejectionReason?: ObservationRejectionReason;
  rejectionHistory?: ObservationRejectionDebug[];
  qualityScore?: number;
  positionSource?: string;
  isMlat?: boolean;
  websocketPublishedAt?: string;
  transitionHistory?: FlightTransitionDebug[];

  // ground/air phase (hysteresis-confirmed)
  airborne: boolean;
  groundStreak: number;
  airborneStreak: number;

  // vertical phase machine (hysteresis-confirmed)
  vertical: VerticalMachineState;
  climbStreak: number;
  descentStreak: number;
  levelStreak: number;
  /** Monotonic index of confirmed vertical transitions (idempotency keys). */
  vphaseSeq: number;
  /** Has the flight reached a cruise/level segment since the last climb? */
  reachedCruise: boolean;

  // per-leg flags
  everAirborne: boolean;
  takeoffEmitted: boolean;
  landingEmitted: boolean;
}

/** Tunable detector thresholds (see docs/07 §7.4). Injected for testability. */
export interface DetectorConfig {
  /** Consecutive samples required to confirm a ground↔air transition. */
  transitionConfirmSamples: number;
  /** Consecutive samples required to confirm a vertical-phase change. */
  verticalConfirmSamples: number;
  /** Vertical rate (fpm) above which the aircraft is climbing. */
  climbThresholdFpm: number;
  /** Vertical rate (fpm) below which the aircraft is descending. */
  descentThresholdFpm: number;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  transitionConfirmSamples: 3,
  verticalConfirmSamples: 2,
  climbThresholdFpm: 500,
  descentThresholdFpm: -500,
};

export interface FlightLifecycleConfig {
  /** Sample age at or below this threshold is considered live. */
  liveAfterMs: number;
  /** Sample age above liveAfterMs and at or below this threshold is delayed. */
  delayedAfterMs: number;
  /** Sample age above delayedAfterMs and at or below this threshold is stale. */
  staleAfterMs: number;
  /** Sample age above staleAfterMs and at or below this threshold is signal_lost. */
  removeAfterMs: number;
  /** Live-source observations older than this are rejected before state diffing. */
  maxPositionAgeMs: number;
}

export const DEFAULT_FLIGHT_LIFECYCLE_CONFIG: FlightLifecycleConfig = {
  liveAfterMs: 15_000,
  delayedAfterMs: 30_000,
  staleAfterMs: 60_000,
  removeAfterMs: 90_000,
  maxPositionAgeMs: 30_000,
};

export function classifyFlightQuality(
  ageMs: number,
  cfg: FlightLifecycleConfig,
): FlightQualityState {
  if (ageMs <= cfg.liveAfterMs) return 'live';
  if (ageMs <= cfg.delayedAfterMs) return 'delayed';
  if (ageMs <= cfg.staleAfterMs) return 'stale';
  return 'signal_lost';
}

export function currentFlightQuality(state: Pick<FlightState, 'qualityState'>): FlightQualityState {
  return state.qualityState ?? 'live';
}
