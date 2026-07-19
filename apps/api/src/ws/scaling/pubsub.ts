import { type AdapterFactory, type Logger, selectAdapter } from '@flytrace/shared';
import type { Redis } from 'ioredis';

/**
 * Pub/Sub port for WebSocket horizontal scaling (docs/12 §12.8). Every api node
 * subscribes to the channels for the shards its connected viewports overlap and
 * publishes position deltas to those channels; the fan-out is node-to-node via
 * this transport, so any node can serve any client.
 *
 * The DEFAULT is {@link InMemoryPubSub} (single-process, zero deps) so the whole
 * stack boots offline; {@link RedisPubSub} is env-gated (`WS_PUBSUB_BACKEND=redis`)
 * and uses a dedicated `duplicate()` connection for the subscriber, mirroring the
 * existing {@link RedisFanout} and the shared `EventBus` split.
 */
export type PubSubHandler = (channel: string, message: string) => void;
/** Removes a single subscription (idempotent). */
export type Unsub = () => Promise<void>;

export interface PubSubAdapter {
  /** Publish `msg` to `channel` (fire-and-forget fan-out). */
  publish(channel: string, msg: string): Promise<void>;
  /** Subscribe `handler` to `channel`; resolves once the subscription is live. */
  subscribe(channel: string, handler: PubSubHandler): Promise<Unsub>;
  /** Tear down the adapter and any underlying connection. */
  close(): Promise<void>;
}

/**
 * Synchronous, single-process bus. Dispatches to subscribers in registration
 * order. `prefix` is prepended to every channel so key-space matches the Redis
 * adapter (handlers always receive the fully-qualified channel).
 */
export class InMemoryPubSub implements PubSubAdapter {
  private readonly handlers = new Map<string, Set<PubSubHandler>>();
  private closed = false;

  constructor(private readonly prefix = '') {}

  async publish(channel: string, msg: string): Promise<void> {
    if (this.closed) return;
    const set = this.handlers.get(this.prefix + channel);
    if (!set) return;
    for (const handler of [...set]) handler(this.prefix + channel, msg);
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<Unsub> {
    const key = this.prefix + channel;
    const set = this.handlers.get(key) ?? new Set<PubSubHandler>();
    set.add(handler);
    this.handlers.set(key, set);
    return async () => {
      const current = this.handlers.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(key);
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.handlers.clear();
  }
}

/**
 * ioredis-backed adapter. One shared subscriber connection (`duplicate()`) fans
 * every Redis `message` event to the local per-channel handler set, so N logical
 * subscriptions cost one SUBSCRIBE per distinct channel. Publishing uses the
 * primary connection. `prefix` namespaces the Redis key-space by environment.
 */
export class RedisPubSub implements PubSubAdapter {
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<PubSubHandler>>();
  private listening = false;

  constructor(
    private readonly pub: Redis,
    private readonly prefix = '',
    private readonly logger?: Logger,
  ) {
    this.sub = pub.duplicate();
  }

  private ensureListener(): void {
    if (this.listening) return;
    this.listening = true;
    this.sub.on('message', (channel: string, message: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      for (const handler of [...set]) {
        try {
          handler(channel, message);
        } catch (err) {
          this.logger?.warn('ws:pubsub handler threw', { channel, err: String(err) });
        }
      }
    });
  }

  async publish(channel: string, msg: string): Promise<void> {
    await this.pub.publish(this.prefix + channel, msg);
  }

  async subscribe(channel: string, handler: PubSubHandler): Promise<Unsub> {
    this.ensureListener();
    const key = this.prefix + channel;
    let set = this.handlers.get(key);
    if (!set) {
      set = new Set<PubSubHandler>();
      this.handlers.set(key, set);
      await this.sub.subscribe(key);
    }
    set.add(handler);
    return async () => {
      const current = this.handlers.get(key);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.handlers.delete(key);
        await this.sub.unsubscribe(key);
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    this.listening = false;
    this.sub.disconnect();
  }
}

export interface CreatePubSubOptions {
  /** `WS_PUBSUB_BACKEND`: 'memory' (default) | 'redis'. */
  backend?: string | undefined;
  /** Primary ioredis connection; required for the 'redis' backend. */
  redis?: Redis | undefined;
  /** Environment key prefix (e.g. `redisKeyPrefix(APP_ENV)`). */
  prefix?: string | undefined;
  logger?: Logger | undefined;
}

/**
 * Resolve the configured Pub/Sub adapter, defaulting to in-memory. The 'redis'
 * adapter is only offered when a connection is supplied, so requesting it
 * without Redis degrades to memory (never throws) — local dev always boots.
 */
export function createPubSub(opts: CreatePubSubOptions = {}): Promise<PubSubAdapter> {
  const prefix = opts.prefix ?? '';
  const logger = opts.logger;
  const adapters: Record<string, AdapterFactory<PubSubAdapter>> = {
    memory: () => new InMemoryPubSub(prefix),
  };
  if (opts.redis) {
    const redis = opts.redis;
    adapters.redis = () => new RedisPubSub(redis, prefix, logger);
  }
  return selectAdapter<PubSubAdapter>({
    label: 'ws:pubsub',
    kind: opts.backend,
    adapters,
    fallback: 'memory',
    ...(logger
      ? {
          logger: {
            warn: (m: string, meta?: unknown) => logger.warn(m, meta as Record<string, unknown>),
            info: (m: string, meta?: unknown) => logger.info(m, meta as Record<string, unknown>),
          },
        }
      : {}),
  });
}
