import type { FlightState } from '../domain/flight-state.ts';

/** Hot per-flight state store (docs/09 §9.8). Rebuildable; not source of truth. */
export interface FlightStateStore {
  get(flightId: string): Promise<FlightState | null>;
  set(state: FlightState): Promise<void>;
  delete(flightId: string): Promise<void>;
  /** All currently-tracked states (for the idle-timeout sweep). */
  all(): Promise<FlightState[]>;
}

/**
 * Resolves a stable `flightId` for a live aircraft. The tracker mints an id on
 * first sight (new leg) and keeps the icao24→flightId mapping until the leg
 * ends; a later reappearance mints a fresh id. Persistence of the `flights` row
 * is the worker's job (via the FlightDetected event) — the tracker stays
 * DB-free per the extraction rules (docs/06 §6.1).
 */
export interface FlightRegistry {
  resolve(icao24: string): Promise<{ flightId: string; isNew: boolean }>;
  release(icao24: string): Promise<void>;
}

/** Distributed lock for leader election / poll-shard ownership (docs/09 §9.9). */
export interface Lock {
  /** Acquire `name` for `ttlMs`; returns a fencing token, or null if held. */
  acquire(name: string, ttlMs: number): Promise<string | null>;
  /** Extend a held lock; false if the token no longer owns it. */
  renew(name: string, token: string, ttlMs: number): Promise<boolean>;
  release(name: string, token: string): Promise<void>;
}
