import {
  type Clock,
  type DomainEventInput,
  type EventBus,
  type Logger,
  makeEnvelope,
} from '@flytrace/shared';
import { detectStep, endFlightEvent } from '../domain/detectors.ts';
import type { DetectorConfig } from '../domain/flight-state.ts';
import type { PositionSource } from '../source/port.ts';
import type { FlightRegistry, FlightStateStore, Lock } from '../state/port.ts';

export interface TrackerOptions {
  detector: DetectorConfig;
  /** Label recorded as the event `source` (e.g. "opensky" | "fixture"). */
  sourceLabel: string;
  /** Idle time (ms) after the last sample before a flight is force-ended. */
  flightTimeoutMs: number;
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
   * The tracker's logical "now" for staleness = the latest sample timestamp it
   * has observed (event time), NOT wall-clock. This keeps the idle sweep
   * correct under replay (a 2023 fixture must not be judged stale against a 2026
   * wall-clock) and live alike, where observed time tracks real time anyway.
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
    const { store, registry, options } = this.deps;
    for (const obs of positions) {
      const { flightId } = await registry.resolve(obs.icao24);
      const prev = await store.get(flightId);
      const { events, next, accepted } = detectStep(prev, obs, flightId, {
        config: options.detector,
        source: options.sourceLabel,
      });
      if (!accepted) continue;
      this.observedMs = Math.max(this.observedMs, Date.parse(obs.ts));
      await store.set(next);
      await this.emitAll(events, flightId);
    }
  }

  /**
   * Force-end flights whose last sample is older than the idle timeout, measured
   * against event time ({@link observedMs}), not wall-clock. The FlightEnded
   * timestamp uses that same logical clock so the event ordering stays coherent.
   */
  private async sweep(): Promise<void> {
    const { store, registry, clock, options } = this.deps;
    const reference = this.observedMs || clock.now();
    for (const state of await store.all()) {
      if (reference - Date.parse(state.lastTs) <= options.flightTimeoutMs) continue;
      const reason = state.landingEmitted ? 'landed' : 'timeout';
      const endedAt = new Date(reference).toISOString();
      await this.emitAll([endFlightEvent(state, reason, endedAt)], state.flightId);
      await store.delete(state.flightId);
      await registry.release(state.icao24);
    }
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
