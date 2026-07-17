import type { EventEnvelope, EventType } from '../events/index.ts';

/**
 * Event bus port (see docs/07 §7.6, docs/09 §9.6).
 *
 * Business code depends on this interface, never on a concrete transport. The
 * production adapter publishes to Redis Pub/Sub (instant fan-out) + Streams
 * (durable, replayable); tests use {@link InMemoryEventBus}. Stream replay
 * (`readFrom`) is introduced with the Redis adapter in the WebSocket increment.
 */
/**
 * Transport naming contract (docs/09 §9.4/§9.5), shared by publishers
 * (tracker/worker) and subscribers (api WS gateway) so both agree on where
 * events live. The env prefix (`flytrace:prod:`) is applied by the adapter.
 */
export const busChannels = {
  /** Fire-and-forget realtime fan-out of all domain events. */
  events: 'rt:events',
  /** Per-flight realtime channel (flight page). */
  flight: (flightId: string): string => `rt:flight:${flightId}`,
  /** Viewport-sharded position channel. */
  positions: (geohashPrefix: string): string => `rt:positions:${geohashPrefix}`,
} as const;

export const streamKeys = {
  /** Durable, replayable domain-event log (consumer groups). */
  events: 'stream:events',
  /** Per-flight capped delta stream (WS reconnect backfill). */
  flight: (flightId: string): string => `stream:flight:${flightId}`,
} as const;

/**
 * Redis key namespace for an environment (docs/09 §9.2), e.g. `flytrace:prod:`.
 * Shared so every app (tracker publisher, api subscriber) agrees on the prefix.
 */
export function redisKeyPrefix(appEnv: 'local' | 'staging' | 'production'): string {
  const env = appEnv === 'production' ? 'prod' : appEnv === 'staging' ? 'stg' : 'local';
  return `flytrace:${env}:`;
}

export type EventHandler = (event: EventEnvelope) => void | Promise<void>;

export interface EventBus {
  publish(event: EventEnvelope): Promise<void>;
  /** Subscribe to one event type, or `'*'` for all. Returns an unsubscribe fn. */
  subscribe(type: EventType | '*', handler: EventHandler): () => void;
}

/**
 * Synchronous in-memory bus for unit tests and offline dev. Records every
 * published event (for assertions) and dispatches to subscribers in order.
 * Handler errors are collected, not swallowed, so tests can surface them.
 */
export class InMemoryEventBus implements EventBus {
  readonly published: EventEnvelope[] = [];
  private readonly handlers = new Map<EventType | '*', Set<EventHandler>>();

  async publish(event: EventEnvelope): Promise<void> {
    this.published.push(event);
    const targets = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
    for (const handler of targets) {
      await handler(event);
    }
  }

  subscribe(type: EventType | '*', handler: EventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler);
    };
  }

  /** Test helper: every published event of a given type. */
  ofType(type: EventType): EventEnvelope[] {
    return this.published.filter((e) => e.type === type);
  }

  clear(): void {
    this.published.length = 0;
  }
}
