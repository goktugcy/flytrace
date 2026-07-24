import { headingDelta } from './geo.ts';
import type { AirportGroundIndex } from './spatial.ts';
import {
  DEFAULT_GROUND_CONFIG,
  type GroundConfig,
  type GroundObs,
  type GroundState,
  type GroundTrack,
} from './types.ts';

export interface GroundStep {
  track: GroundTrack;
  /** True when the state changed vs the previous track (emit an event). */
  changed: boolean;
}

const ARRIVAL_LINEAGE = new Set<GroundState>([
  'APPROACH',
  'DESCENT',
  'LANDING',
  'TAXI_IN',
  'ARRIVED_GATE',
]);

/**
 * Advance the ground state for one observation. Pure: same (prev, obs, index,
 * cfg) always yields the same result. Combines geometry (which runway/taxiway/
 * gate/apron the point is on) with speed, vertical rate, heading, altitude, the
 * previous state, and dwell time.
 */
export function stepGroundState(
  prev: GroundTrack | null,
  obs: GroundObs,
  index: AirportGroundIndex,
  cfg: GroundConfig = DEFAULT_GROUND_CONFIG,
): GroundStep {
  const prevState: GroundState = prev?.state ?? 'UNKNOWN';
  const speed = obs.gsKt ?? 0;
  const alt = obs.altFt;
  const vrate = obs.verticalRateFpm ?? 0;
  const airborne = !obs.onGround && (alt == null || alt > cfg.airborneAltFt);

  const gate = index.nearestGate(obs.lat, obs.lon);
  const withinGate = gate != null && gate.distM <= cfg.gateRadiusM;
  const runway = index.nearestRunway(obs.lat, obs.lon);
  const runwayDist = runway?.distM ?? Number.POSITIVE_INFINITY;
  const onRunway = runwayDist <= cfg.onFeatureToleranceM;
  const taxiway = index.nearestTaxiway(obs.lat, obs.lon);
  const onTaxiway = (taxiway?.distM ?? Number.POSITIVE_INFINITY) <= cfg.onFeatureToleranceM;
  const area = index.containingArea(obs.lat, obs.lon);
  const arrival = (prev?.everAirborne ?? false) || ARRIVAL_LINEAGE.has(prevState);
  const stationaryAtGate = withinGate && speed < cfg.parkedSpeedKt;

  // Gate-arrival dwell: only commit AT_GATE / ARRIVED_GATE after the aircraft
  // has held stationary at the gate for gateDwellMs.
  let gateStationarySinceMs = prev?.gateStationarySinceMs ?? null;
  if (stationaryAtGate) {
    if (gateStationarySinceMs == null) gateStationarySinceMs = obs.tsMs;
  } else {
    gateStationarySinceMs = null;
  }
  const gateDwellMet =
    gateStationarySinceMs != null && obs.tsMs - gateStationarySinceMs >= cfg.gateDwellMs;

  const state = classify({
    prevState,
    speed,
    alt,
    vrate,
    airborne,
    withinGate,
    gateDwellMet,
    runwayDist,
    onRunway,
    onTaxiway,
    area,
    arrival,
    headingChanged:
      prev?.lastHeadingDeg != null &&
      obs.headingDeg != null &&
      headingDelta(prev.lastHeadingDeg, obs.headingDeg) >= cfg.pushbackHeadingDeltaDeg,
    cfg,
  });

  const changed = state !== prevState;
  const track: GroundTrack = {
    state,
    sinceMs: changed ? obs.tsMs : (prev?.sinceMs ?? obs.tsMs),
    atMs: obs.tsMs,
    gateRef: withinGate ? (gate?.ref ?? prev?.gateRef ?? null) : (prev?.gateRef ?? null),
    runwayRef: onRunway ? (runway?.ref ?? prev?.runwayRef ?? null) : (prev?.runwayRef ?? null),
    lastHeadingDeg: obs.headingDeg ?? prev?.lastHeadingDeg ?? null,
    lastGsKt: speed,
    everAirborne: (prev?.everAirborne ?? false) || airborne,
    gateStationarySinceMs,
  };
  return { track, changed };
}

interface ClassifyInput {
  prevState: GroundState;
  speed: number;
  alt: number | null;
  vrate: number;
  airborne: boolean;
  withinGate: boolean;
  gateDwellMet: boolean;
  runwayDist: number;
  onRunway: boolean;
  onTaxiway: boolean;
  area: string | null;
  arrival: boolean;
  headingChanged: boolean;
  cfg: GroundConfig;
}

function classify(i: ClassifyInput): GroundState {
  const { cfg, prevState, speed } = i;

  if (i.airborne) {
    if (prevState === 'TAKEOFF_ROLL' || prevState === 'LINE_UP') return 'AIRBORNE';
    if (i.vrate >= cfg.climbVrateFpm) return 'CLIMB';
    if (i.vrate <= cfg.descentVrateFpm) {
      if (i.alt != null && i.alt <= cfg.approachAltFt && i.runwayDist < 15_000) return 'APPROACH';
      return 'DESCENT';
    }
    return 'CRUISE';
  }

  // ── On the ground ──
  // Touchdown / rollout after an arrival.
  if (
    i.onRunway &&
    (prevState === 'APPROACH' ||
      prevState === 'DESCENT' ||
      prevState === 'AIRBORNE' ||
      prevState === 'LANDING')
  ) {
    return 'LANDING';
  }
  // Departure runway phases.
  if (i.onRunway && speed >= cfg.takeoffRollKt) return 'TAKEOFF_ROLL';
  if (i.onRunway && speed < cfg.taxiMaxKt) return 'LINE_UP';
  // Holding short of the runway before departure.
  if (
    !i.onRunway &&
    i.runwayDist <= cfg.holdShortRunwayDistM &&
    speed < cfg.taxiMinKt &&
    i.onTaxiway
  ) {
    return 'HOLD_SHORT';
  }
  // Taxiing — arrival vs departure by lineage.
  if (i.onTaxiway && speed >= cfg.taxiMinKt && speed <= cfg.taxiMaxKt) {
    return i.arrival ? 'TAXI_IN' : 'TAXI_OUT';
  }
  // Parked at a gate (after the dwell rule is met).
  if (i.withinGate && speed < cfg.parkedSpeedKt && i.gateDwellMet) {
    return i.arrival ? 'ARRIVED_GATE' : 'AT_GATE';
  }
  // Pushback: leaving the gate slowly, optionally with a heading change.
  if (
    (prevState === 'AT_GATE' || prevState === 'PUSHBACK') &&
    speed >= cfg.parkedSpeedKt &&
    speed < cfg.taxiMaxKt
  ) {
    return 'PUSHBACK';
  }
  // Stationary away from a gate.
  if (
    speed < cfg.parkedSpeedKt &&
    (i.area === 'apron' || i.area === 'parking' || i.area === 'terminal')
  ) {
    return 'PARKED_REMOTE';
  }
  // Ambiguous single sample → hold the previous ground state to avoid flapping.
  return prevState;
}

/** Seed a fresh track (first observation of an aircraft). */
export function initialGroundTrack(obs: GroundObs): GroundTrack {
  return {
    state: 'UNKNOWN',
    sinceMs: obs.tsMs,
    atMs: obs.tsMs,
    gateRef: null,
    runwayRef: null,
    lastHeadingDeg: obs.headingDeg ?? null,
    lastGsKt: obs.gsKt ?? 0,
    everAirborne: !obs.onGround,
    gateStationarySinceMs: null,
  };
}
