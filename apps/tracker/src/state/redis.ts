import { type Clock, systemClock, uuidv7 } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import type { FlightState } from '../domain/flight-state.ts';
import type { FlightRegistry, FlightStateStore, Lock } from './port.ts';

/**
 * Redis-backed hot state (docs/09 §9.8). Keys are namespaced
 * `<prefix>flight:state:<id>`; `<prefix>flights:active` mirrors the live set.
 * State carries a TTL safety-net so a crashed tracker can't leak keys forever.
 */
export class RedisFlightStateStore implements FlightStateStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlMs: number,
  ) {}

  private stateKey(flightId: string): string {
    return `${this.prefix}flight:state:${flightId}`;
  }
  private get activeKey(): string {
    return `${this.prefix}flights:active`;
  }

  async get(flightId: string): Promise<FlightState | null> {
    const raw = await this.redis.get(this.stateKey(flightId));
    return raw ? (JSON.parse(raw) as FlightState) : null;
  }

  async set(state: FlightState): Promise<void> {
    await this.redis
      .multi()
      .set(this.stateKey(state.flightId), JSON.stringify(state), 'PX', this.ttlMs)
      .sadd(this.activeKey, state.flightId)
      .exec();
  }

  async delete(flightId: string): Promise<void> {
    await this.redis.multi().del(this.stateKey(flightId)).srem(this.activeKey, flightId).exec();
  }

  async all(): Promise<FlightState[]> {
    const ids = await this.redis.smembers(this.activeKey);
    if (ids.length === 0) return [];
    const raws = await this.redis.mget(ids.map((id) => this.stateKey(id)));
    const out: FlightState[] = [];
    for (let i = 0; i < ids.length; i += 1) {
      const raw = raws[i];
      if (raw) out.push(JSON.parse(raw) as FlightState);
      else await this.redis.srem(this.activeKey, ids[i] as string); // expired — reconcile
    }
    return out;
  }
}

/** Redis-backed {@link FlightRegistry} — `<prefix>flight:key:<icao24>` → flightId. */
export class RedisFlightRegistry implements FlightRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly ttlMs: number,
    private readonly clock: Clock = systemClock,
  ) {}

  private key(icao24: string): string {
    return `${this.prefix}flight:key:${icao24}`;
  }

  async resolve(icao24: string): Promise<{ flightId: string; isNew: boolean }> {
    const key = this.key(icao24);
    const candidate = uuidv7(this.clock.now());
    // Atomic first-writer-wins: NX sets only if absent.
    const set = await this.redis.set(key, candidate, 'PX', this.ttlMs, 'NX');
    if (set === 'OK') return { flightId: candidate, isNew: true };
    const existing = await this.redis.get(key);
    if (existing) {
      await this.redis.pexpire(key, this.ttlMs); // refresh liveness
      return { flightId: existing, isNew: false };
    }
    // Rare race: key vanished between NX and GET — mint fresh.
    await this.redis.set(key, candidate, 'PX', this.ttlMs);
    return { flightId: candidate, isNew: true };
  }

  async release(icao24: string): Promise<void> {
    await this.redis.del(this.key(icao24));
  }
}

const RENEW_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Redis {@link Lock} via `SET NX PX` + fencing token (docs/09 §9.9). */
export class RedisLock implements Lock {
  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private key(name: string): string {
    return `${this.prefix}lock:${name}`;
  }

  async acquire(name: string, ttlMs: number): Promise<string | null> {
    const token = uuidv7(this.clock.now());
    const res = await this.redis.set(this.key(name), token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  async renew(name: string, token: string, ttlMs: number): Promise<boolean> {
    const res = await this.redis.eval(RENEW_LUA, 1, this.key(name), token, String(ttlMs));
    return res === 1;
  }

  async release(name: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, this.key(name), token);
  }
}
