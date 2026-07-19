import {
  type Clock,
  type DomainEventInput,
  type EventBus,
  type Logger,
  makeEnvelope,
} from '@flytrace/shared';
import { detectStep, endFlightEvent, flightLifecycleEvent } from '../domain/detectors.ts';
import {
  type DetectorConfig,
  type FlightLifecycleConfig,
  type FlightQualityState,
  type FlightState,
  classifyFlightQuality,
  currentFlightQuality,
} from '../domain/flight-state.ts';
import type { PositionSource, SourceTimeMode } from '../source/port.ts';
import type { FlightRegistry, FlightStateStore, Lock } from '../state/port.ts';

export interface TrackerOptions {
  detector: DetectorConfig;
  /** Label recorded as the event `source` (e.g. "opensky" | "fixture"). */
  sourceLabel: string;
  /** Whether freshness uses processing time (live) or event time (fixtures). */
  sourceTimeMode: SourceTimeMode;
  /** Realtime freshness lifecycle thresholds. */
  lifecycle: FlightLifecycleConfig;
  /** Poll cadence (ms) for the production loop. */
  pollIntervalMs: number;
  /** Leader/shard lock name + TTL (production loop only). */
  lockName: string;
  lockTtlMs: number;
}

export interface TrackerDeps {
  source: PositionSource;
  store: FlightStateStore;
  registry: FlightRegistry;
  lock: Lock;
  bus: EventBus;
  clock: Clock;
  logger: Logger;
  options: TrackerOptions;
}

/**
 * The tracker orchestrator (docs/06 §6.7 golden path). Each tick: poll the
 * source, resolve a flightId per aircraft, diff against hot state via the pure
 * {@link detectStep}, persist the next state, and publish derived events to the
 * bus. A per-tick sweep force-ends flights that have gone idle.
 *
 * All time comes from the injected {@link Clock}; all derivation is pure — so a
 * fixture feed produces a deterministic, assertable event stream.
 */
export class Tracker {
  private running = false;
  private lockToken: string | null = null;
  /**
   * The tracker's logical event-time "now" for replay sources. Live sources use
   * wall time for freshness; fixtures use this so a 2023 recording is not aged
   * against a 2026 wall clock.
   */
  private observedMs = 0;

  constructor(private readonly deps: TrackerDeps) {}

  /** One poll → process → sweep cycle. Safe to call directly in tests. */
  async tick(): Promise<void> {
    const positions = await this.deps.source.poll();
    await this.process(positions);
    await this.sweep();
  }

  private async process(positions: Awaited<ReturnType<PositionSource['poll']>>): Promise<void> {
    const { store, registry, options, clock, logger } = this.deps;
    const receivedAtMs = clock.now();
    for (const obs of positions) {
      const obsMs = Date.parse(obs.ts);
      if (!Number.isFinite(obsMs)) continue;
      const sourceMs = Date.parse(obs.sourceTimestamp ?? obs.ts);
      const ageMs =
        obs.ageMs ??
        (Number.isFinite(sourceMs)
          ? Math.max(0, receivedAtMs - sourceMs)
          : Math.max(0, receivedAtMs - obsMs));
      if (options.sourceTimeMode === 'wall' && ageMs > options.lifecycle.maxPositionAgeMs) {
        logger.debug('dropping stale provider observation', {
          icao24: obs.icao24,
          ts: obs.ts,
          age_ms: ageMs,
        });
        continue;
      }

      const { flightId } = await registry.resolve(obs.icao24);
      const prev = await store.get(flightId);
      const receivedAtFromObs = obs.receivedAt ? Date.parse(obs.receivedAt) : Number.NaN;
      const acceptedAtMs =
        options.sourceTimeMode === 'wall' && Number.isFinite(receivedAtFromObs)
          ? receivedAtFromObs
          : options.sourceTimeMode === 'wall'
            ? receivedAtMs
            : obsMs;
      const { events, next, accepted } = detectStep(prev, obs, flightId, {
        config: options.detector,
        source: obs.source ?? options.sourceLabel,
        acceptedAt: new Date(acceptedAtMs).toISOString(),
        ageMs: options.sourceTimeMode === 'wall' ? ageMs : 0,
      });
      if (!accepted) continue;
      this.observedMs = Math.max(this.observedMs, obsMs);
      await store.set(next);
      await this.emitAll(events, flightId);
    }
  }

  /**
   * Advance the freshness lifecycle for idle flights and force-end them after
   * removeAfterMs. Live sources use wall-clock so a missing aircraft disappears
   * even if no newer event arrives; fixture sources keep event-time semantics.
   */
  private async sweep(): Promise<void> {
    const { store, registry, clock, options } = this.deps;
    const reference =
      options.sourceTimeMode === 'wall' ? clock.now() : this.observedMs || clock.now();
    for (const state of await store.all()) {
      const lastTsMs = Date.parse(state.lastTs);
      if (!Number.isFinite(lastTsMs)) continue;
      const ageMs = Math.max(0, reference - lastTsMs);
      if (ageMs <= options.lifecycle.removeAfterMs) {
        await this.transitionQualityIfNeeded(state, ageMs, reference);
        continue;
      }
      const reason = state.landingEmitted ? 'landed' : 'timeout';
      const endedAt = new Date(reference).toISOString();
      await this.emitAll([endFlightEvent(state, reason, endedAt)], state.flightId);
      await store.delete(state.flightId);
      await registry.release(state.icao24);
    }
  }

  private async transitionQualityIfNeeded(
    state: FlightState,
    ageMs: number,
    referenceMs: number,
  ): Promise<void> {
    const nextQuality = classifyFlightQuality(ageMs, this.deps.options.lifecycle);
    if (nextQuality === currentFlightQuality(state)) return;

    const at = new Date(referenceMs).toISOString();
    const next: FlightState & { qualityState: FlightQualityState } = {
      ...state,
      qualityState: nextQuality,
      lastQualityTransitionAt: at,
      lifecycleSeq: (state.lifecycleSeq ?? 0) + 1,
    };
    await this.deps.store.set(next);
    await this.emitAll(
      [flightLifecycleEvent(lifecycleEventType(nextQuality), next, at, ageMs)],
      state.flightId,
    );
  }

  private async emitAll(events: DomainEventInput[], correlationId: string): Promise<void> {
    for (const input of events) {
      const envelope = makeEnvelope(input, {
        producer: 'tracker',
        clock: this.deps.clock,
        correlationId,
      });
      await this.deps.bus.publish(envelope);
    }
  }

  /** Drain a finite source (fixture) to completion — deterministic, no timers. */
  async drain(): Promise<void> {
    while (!this.deps.source.done) {
      await this.tick();
    }
  }

  /**
   * Production loop: contend for leadership, then poll on cadence while holding
   * the lock. Non-leaders stand by and retry (docs/08 §8.3 single poller).
   */
  async start(): Promise<void> {
    this.running = true;
    const { lock, logger, options, clock } = this.deps;
    logger.info('tracker starting', { source: this.deps.source.name });

    while (this.running) {
      if (this.lockToken === null) {
        this.lockToken = await lock.acquire(options.lockName, options.lockTtlMs);
        if (this.lockToken === null) {
          logger.debug('not leader, standing by');
          await sleep(options.lockTtlMs / 2);
          continue;
        }
        logger.info('acquired leadership', { lock: options.lockName });
      }

      const startedAt = clock.now();
      try {
        await this.tick();
      } catch (err) {
        logger.error('tick failed', { err: String(err) });
      }

      const renewed = await lock.renew(options.lockName, this.lockToken, options.lockTtlMs);
      if (!renewed) {
        logger.warn('lost leadership');
        this.lockToken = null;
      }

      const elapsed = clock.now() - startedAt;
      await sleep(Math.max(0, options.pollIntervalMs - elapsed));
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.lockToken !== null) {
      await this.deps.lock.release(this.deps.options.lockName, this.lockToken);
      this.lockToken = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lifecycleEventType(
  quality: Exclude<FlightQualityState, 'live'>,
): 'FlightDelayed' | 'FlightStale' | 'FlightSignalLost';
function lifecycleEventType(
  quality: FlightQualityState,
): 'FlightDelayed' | 'FlightStale' | 'FlightSignalLost' | 'FlightRecovered';
function lifecycleEventType(quality: FlightQualityState) {
  switch (quality) {
    case 'delayed':
      return 'FlightDelayed';
    case 'stale':
      return 'FlightStale';
    case 'signal_lost':
      return 'FlightSignalLost';
    case 'live':
      return 'FlightRecovered';
  }
}
