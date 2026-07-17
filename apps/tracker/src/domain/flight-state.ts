/**
 * The hot, per-flight state the tracker diffs against to derive events
 * (docs/09 §9.8). Rebuildable from Postgres if Redis is lost; never the source
 * of truth. Kept deliberately small and JSON-serializable (Redis hash value).
 */

export type VerticalMachineState = 'climb' | 'level' | 'descent';

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
  lastTs: string; // ISO of the last accepted sample

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
