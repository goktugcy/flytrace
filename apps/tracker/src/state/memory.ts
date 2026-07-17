import { type Clock, systemClock, uuidv7 } from '@flytrace/shared';
import type { FlightState } from '../domain/flight-state.ts';
import type { FlightRegistry, FlightStateStore, Lock } from './port.ts';

/** In-memory {@link FlightStateStore} for tests and offline dev. */
export class InMemoryFlightStateStore implements FlightStateStore {
  private readonly states = new Map<string, FlightState>();

  async get(flightId: string): Promise<FlightState | null> {
    return this.states.get(flightId) ?? null;
  }
  async set(state: FlightState): Promise<void> {
    this.states.set(state.flightId, { ...state });
  }
  async delete(flightId: string): Promise<void> {
    this.states.delete(flightId);
  }
  async all(): Promise<FlightState[]> {
    return [...this.states.values()];
  }
}

/** In-memory {@link FlightRegistry}. */
export class InMemoryFlightRegistry implements FlightRegistry {
  private readonly byIcao = new Map<string, string>();

  constructor(private readonly clock: Clock = systemClock) {}

  async resolve(icao24: string): Promise<{ flightId: string; isNew: boolean }> {
    const existing = this.byIcao.get(icao24);
    if (existing) return { flightId: existing, isNew: false };
    const flightId = uuidv7(this.clock.now());
    this.byIcao.set(icao24, flightId);
    return { flightId, isNew: true };
  }
  async release(icao24: string): Promise<void> {
    this.byIcao.delete(icao24);
  }
}

/** In-memory {@link Lock} — always grantable in a single process (no-op leader). */
export class InMemoryLock implements Lock {
  private readonly held = new Map<string, { token: string; expiresAt: number }>();

  constructor(private readonly clock: Clock = systemClock) {}

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const now = this.clock.now();
    const cur = this.held.get(name);
    if (cur && cur.expiresAt > now) return null;
    const token = uuidv7(now);
    this.held.set(name, { token, expiresAt: now + ttlMs });
    return token;
  }
  async renew(name: string, token: string, ttlMs: number): Promise<boolean> {
    const cur = this.held.get(name);
    if (!cur || cur.token !== token) return false;
    this.held.set(name, { token, expiresAt: this.clock.now() + ttlMs });
    return true;
  }
  async release(name: string, token: string): Promise<void> {
    const cur = this.held.get(name);
    if (cur && cur.token === token) this.held.delete(name);
  }
}
