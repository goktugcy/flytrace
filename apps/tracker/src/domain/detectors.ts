import type {
  DomainEventInput,
  FlightDetectedPayload,
  FlightEndReason,
  FlightEndedPayload,
  FlightLifecyclePayload,
  PhaseEventPayload,
  PositionPayload,
  TransitionPayload,
  VerticalPhase,
} from '@flytrace/shared';
import {
  DEFAULT_DETECTOR_CONFIG,
  type DetectorConfig,
  type FlightQualityState,
  type FlightState,
  type VerticalMachineState,
  currentFlightQuality,
} from './flight-state.ts';
import type { ObservationRejectionReason } from './observation-debug.ts';
import type { Position } from './position.ts';

/**
 * The pure heart of the tracker: given the previous {@link FlightState} and a
 * new normalized {@link Position}, derive the domain events and the next state.
 *
 * No I/O, no clock, no ids — everything here is a deterministic function of the
 * inputs, so the whole event sequence for a recorded track is golden-file
 * testable (docs/07 §7.9). The engine wraps each {@link DomainEventInput} into a
 * full envelope (adding id / emittedAt / correlationId).
 */
export interface DetectResult {
  events: DomainEventInput[];
  next: FlightState;
  /** False when the sample was dropped as stale/out-of-order (state unchanged). */
  accepted: boolean;
  rejectionReason?: ObservationRejectionReason;
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Deterministic confidence from how far a streak exceeded its confirm bar. */
function transitionConfidence(streak: number, confirm: number): number {
  return clamp01(0.7 + 0.1 * (streak - confirm));
}

function classifyVertical(
  vrateFpm: number | null,
  cfg: DetectorConfig,
): VerticalMachineState | null {
  if (vrateFpm === null) return null;
  if (vrateFpm > cfg.climbThresholdFpm) return 'climb';
  if (vrateFpm < cfg.descentThresholdFpm) return 'descent';
  return 'level';
}

function positionEvent(
  flightId: string,
  obs: Position,
  meta: {
    source: string;
    sourceTimestamp?: string;
    receivedAt?: string;
    ageMs?: number;
    quality?: number;
    positionSource?: string;
    isMlat?: boolean;
  },
): DomainEventInput<PositionPayload> {
  return {
    type: 'PositionUpdated',
    occurredAt: obs.ts,
    dedupeKey: `${flightId}:pos:${obs.ts}`,
    partitionKey: flightId,
    payload: {
      flightId,
      icao24: obs.icao24,
      lat: obs.lat,
      lon: obs.lon,
      altFt: obs.altFt,
      headingDeg: obs.headingDeg,
      gsKt: obs.gsKt,
      vrateFpm: obs.vrateFpm,
      onGround: obs.onGround,
      ts: obs.ts,
      callsign: obs.callsign,
      category: obs.category,
      source: meta.source,
      qualityState: 'live',
      ...(meta.sourceTimestamp !== undefined ? { sourceTimestamp: meta.sourceTimestamp } : {}),
      ...(meta.receivedAt !== undefined ? { receivedAt: meta.receivedAt } : {}),
      ...(meta.ageMs !== undefined ? { ageMs: meta.ageMs } : {}),
      ...(meta.quality !== undefined ? { quality: meta.quality } : {}),
      ...(meta.positionSource !== undefined ? { positionSource: meta.positionSource } : {}),
      ...(meta.isMlat !== undefined ? { isMlat: meta.isMlat } : {}),
    },
  };
}

function initialState(
  flightId: string,
  obs: Position,
  cfg: DetectorConfig,
  acceptedAt: string,
  source: string,
  ageMs?: number,
): FlightState {
  const airborne = !obs.onGround;
  const vertical = classifyVertical(obs.vrateFpm, cfg) ?? 'level';
  return {
    flightId,
    icao24: obs.icao24,
    callsign: obs.callsign,
    lat: obs.lat,
    lon: obs.lon,
    altFt: obs.altFt,
    vrateFpm: obs.vrateFpm,
    gsKt: obs.gsKt,
    headingDeg: obs.headingDeg,
    category: obs.category,
    lastTs: obs.ts,
    qualityState: 'live',
    lastAcceptedAt: acceptedAt,
    lastQualityTransitionAt: acceptedAt,
    lifecycleSeq: 0,
    sequence: 1,
    selectedProvider: source,
    ...(obs.candidateProviders !== undefined ? { candidateProviders: obs.candidateProviders } : {}),
    ...(obs.providerCandidates !== undefined ? { providerCandidates: obs.providerCandidates } : {}),
    sourceTimestamp: obs.sourceTimestamp ?? obs.ts,
    receivedAt: obs.receivedAt ?? acceptedAt,
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(obs.quality !== undefined ? { qualityScore: obs.quality } : {}),
    ...(obs.positionSource !== undefined ? { positionSource: obs.positionSource } : {}),
    ...(obs.isMlat !== undefined ? { isMlat: obs.isMlat } : {}),
    airborne,
    groundStreak: obs.onGround ? cfg.transitionConfirmSamples : 0,
    airborneStreak: obs.onGround ? 0 : cfg.transitionConfirmSamples,
    vertical,
    climbStreak: vertical === 'climb' ? cfg.verticalConfirmSamples : 0,
    descentStreak: vertical === 'descent' ? cfg.verticalConfirmSamples : 0,
    levelStreak: vertical === 'level' ? cfg.verticalConfirmSamples : 0,
    vphaseSeq: 0,
    reachedCruise: airborne && vertical === 'level',
    everAirborne: airborne,
    takeoffEmitted: false,
    landingEmitted: false,
    transitionHistory: [{ at: acceptedAt, to: 'live', ageMs: ageMs ?? 0, sequence: 0 }],
  };
}

export function detectStep(
  prev: FlightState | null,
  obs: Position,
  flightId: string,
  opts: { config?: DetectorConfig; source?: string; acceptedAt?: string; ageMs?: number } = {},
): DetectResult {
  const cfg = opts.config ?? DEFAULT_DETECTOR_CONFIG;
  const source = obs.source ?? opts.source ?? 'opensky';
  const acceptedAt = opts.acceptedAt ?? obs.ts;
  const ageMs = opts.ageMs ?? obs.ageMs;
  const positionMeta = {
    source,
    sourceTimestamp: obs.sourceTimestamp ?? obs.ts,
    receivedAt: acceptedAt,
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(obs.quality !== undefined ? { quality: obs.quality } : {}),
    ...(obs.positionSource !== undefined ? { positionSource: obs.positionSource } : {}),
    ...(obs.isMlat !== undefined ? { isMlat: obs.isMlat } : {}),
  };

  // First sighting of this flight leg.
  if (prev === null) {
    const next = initialState(flightId, obs, cfg, acceptedAt, source, ageMs);
    const detected: DomainEventInput<FlightDetectedPayload> = {
      type: 'FlightDetected',
      occurredAt: obs.ts,
      dedupeKey: `${flightId}:detected`,
      partitionKey: flightId,
      payload: {
        flightId,
        icao24: obs.icao24,
        callsign: obs.callsign,
        firstPosition: { lat: obs.lat, lon: obs.lon, ts: obs.ts },
        source,
      },
    };
    return {
      events: [detected, positionEvent(flightId, obs, positionMeta)],
      next,
      accepted: true,
    };
  }

  // Drop stale / out-of-order samples (docs §7.6).
  const obsMs = Date.parse(obs.ts);
  const prevMs = Date.parse(prev.lastTs);
  if (obsMs <= prevMs) {
    return {
      events: [],
      next: prev,
      accepted: false,
      rejectionReason: obsMs === prevMs ? 'duplicate_timestamp' : 'out_of_order',
    };
  }

  const prevQuality = currentFlightQuality(prev);
  const lifecycleSeq =
    prevQuality === 'live' ? (prev.lifecycleSeq ?? 0) : (prev.lifecycleSeq ?? 0) + 1;
  const events: DomainEventInput[] = [positionEvent(flightId, obs, positionMeta)];
  const next: FlightState & { qualityState: FlightQualityState } = {
    ...prev,
    callsign: obs.callsign ?? prev.callsign,
    lat: obs.lat,
    lon: obs.lon,
    altFt: obs.altFt,
    vrateFpm: obs.vrateFpm,
    gsKt: obs.gsKt,
    headingDeg: obs.headingDeg,
    category: obs.category ?? prev.category,
    lastTs: obs.ts,
    qualityState: 'live',
    lastAcceptedAt: acceptedAt,
    lastQualityTransitionAt:
      prevQuality === 'live' ? (prev.lastQualityTransitionAt ?? acceptedAt) : acceptedAt,
    lifecycleSeq,
    sequence: (prev.sequence ?? 0) + 1,
    selectedProvider: source,
    ...(obs.candidateProviders !== undefined ? { candidateProviders: obs.candidateProviders } : {}),
    ...(obs.providerCandidates !== undefined ? { providerCandidates: obs.providerCandidates } : {}),
    sourceTimestamp: obs.sourceTimestamp ?? obs.ts,
    receivedAt: obs.receivedAt ?? acceptedAt,
    ...(ageMs !== undefined ? { ageMs } : {}),
    ...(obs.quality !== undefined ? { qualityScore: obs.quality } : {}),
    ...(obs.positionSource !== undefined ? { positionSource: obs.positionSource } : {}),
    ...(obs.isMlat !== undefined ? { isMlat: obs.isMlat } : {}),
  };
  if (prevQuality !== 'live') {
    next.transitionHistory = appendTransitionHistory(prev, {
      at: acceptedAt,
      from: prevQuality,
      to: 'live',
      ageMs: 0,
      sequence: lifecycleSeq,
    });
    events.push(flightLifecycleEvent('FlightRecovered', next, acceptedAt, 0));
  }

  // ── Ground ↔ air transitions (takeoff / landing) ──
  if (obs.onGround) {
    next.groundStreak = prev.groundStreak + 1;
    next.airborneStreak = 0;
  } else {
    next.airborneStreak = prev.airborneStreak + 1;
    next.groundStreak = 0;
  }

  const confirm = cfg.transitionConfirmSamples;
  if (!prev.airborne && next.airborneStreak >= confirm) {
    next.airborne = true;
    next.everAirborne = true;
    if (!prev.takeoffEmitted) {
      next.takeoffEmitted = true;
      events.push(
        transitionEvent(
          'TakeoffDetected',
          flightId,
          obs,
          transitionConfidence(next.airborneStreak, confirm),
          source,
        ),
      );
    }
  } else if (prev.airborne && next.groundStreak >= confirm) {
    next.airborne = false;
    if (prev.everAirborne && !prev.landingEmitted) {
      next.landingEmitted = true;
      events.push(
        transitionEvent(
          'LandingDetected',
          flightId,
          obs,
          transitionConfidence(next.groundStreak, confirm),
          source,
        ),
      );
    }
  }

  // ── Vertical phase (climb / descent / TOC / TOD) ── only meaningful airborne
  const obsV = classifyVertical(obs.vrateFpm, cfg);
  if (obsV !== null) {
    next.climbStreak = obsV === 'climb' ? prev.climbStreak + 1 : 0;
    next.descentStreak = obsV === 'descent' ? prev.descentStreak + 1 : 0;
    next.levelStreak = obsV === 'level' ? prev.levelStreak + 1 : 0;

    const vconfirm = cfg.verticalConfirmSamples;
    let confirmed: VerticalMachineState | null = null;
    if (obsV === 'climb' && next.climbStreak >= vconfirm) confirmed = 'climb';
    else if (obsV === 'descent' && next.descentStreak >= vconfirm) confirmed = 'descent';
    else if (obsV === 'level' && next.levelStreak >= vconfirm) confirmed = 'level';

    if (confirmed !== null && confirmed !== prev.vertical) {
      const phase = verticalTransitionPhase(prev.vertical, confirmed, prev.reachedCruise);
      next.vertical = confirmed;
      next.reachedCruise =
        confirmed === 'level' ? prev.vertical === 'climb' || prev.reachedCruise : false;
      // Gate on the raw airborne observation, not the (lagging) confirmed phase:
      // the climb-out begins before takeoff is confirmed over N samples.
      if (!obs.onGround && phase !== null) {
        next.vphaseSeq = prev.vphaseSeq + 1;
        events.push(verticalEvent(phase, flightId, obs, next.vphaseSeq));
      }
    }
  }

  return { events, next, accepted: true };
}

function transitionEvent(
  type: 'TakeoffDetected' | 'LandingDetected',
  flightId: string,
  obs: Position,
  confidence: number,
  source: string,
): DomainEventInput<TransitionPayload> {
  return {
    type,
    occurredAt: obs.ts,
    dedupeKey: `${flightId}:${type === 'TakeoffDetected' ? 'takeoff' : 'landing'}`,
    partitionKey: flightId,
    payload: {
      flightId,
      icao24: obs.icao24,
      at: obs.ts,
      lat: obs.lat,
      lon: obs.lon,
      altFt: obs.altFt,
      confidence,
      source,
    },
  };
}

/** Map a confirmed vertical-machine transition to an emitted phase (or none). */
function verticalTransitionPhase(
  from: VerticalMachineState,
  to: VerticalMachineState,
  reachedCruise: boolean,
): VerticalPhase | null {
  if (to === 'climb') return 'climb';
  if (to === 'descent') return from === 'level' && reachedCruise ? 'top_of_descent' : 'descent';
  // to === 'level'
  if (from === 'climb') return 'top_of_climb';
  return null; // leveling off out of a descent — no event
}

function verticalEvent(
  phase: VerticalPhase,
  flightId: string,
  obs: Position,
  seq: number,
): DomainEventInput<PhaseEventPayload> {
  const type =
    phase === 'descent' || phase === 'top_of_descent' ? 'DescentDetected' : 'ClimbDetected';
  return {
    type,
    occurredAt: obs.ts,
    dedupeKey: `${flightId}:vphase:${phase}:${seq}`,
    partitionKey: flightId,
    payload: {
      flightId,
      phase,
      at: obs.ts,
      altFt: obs.altFt,
      vrateFpm: obs.vrateFpm,
      confidence: 0.8,
      source: 'tracker',
    },
  };
}

export function appendTransitionHistory(
  state: Pick<FlightState, 'transitionHistory'>,
  entry: NonNullable<FlightState['transitionHistory']>[number],
): NonNullable<FlightState['transitionHistory']> {
  return [...(state.transitionHistory ?? []), entry].slice(-12);
}

/** Build a {@link FlightEnded} event (emitted by the engine's timeout sweep). */
export function endFlightEvent(
  state: FlightState,
  reason: FlightEndReason,
  endedAt: string,
): DomainEventInput<FlightEndedPayload> {
  return {
    type: 'FlightEnded',
    occurredAt: endedAt,
    dedupeKey: `${state.flightId}:ended`,
    partitionKey: state.flightId,
    payload: {
      flightId: state.flightId,
      icao24: state.icao24,
      endedAt,
      reason,
    },
  };
}

export function flightLifecycleEvent(
  type: 'FlightDelayed' | 'FlightStale' | 'FlightSignalLost' | 'FlightRecovered',
  state: FlightState & { qualityState: FlightQualityState },
  at: string,
  ageMs: number,
): DomainEventInput<FlightLifecyclePayload> {
  return {
    type,
    occurredAt: at,
    dedupeKey: `${state.flightId}:quality:${state.qualityState}:${state.lifecycleSeq ?? 0}`,
    partitionKey: state.flightId,
    payload: {
      flightId: state.flightId,
      icao24: state.icao24,
      state: state.qualityState,
      at,
      lastPositionAt: state.lastTs,
      ageMs: Math.max(0, Math.round(ageMs)),
    },
  };
}
