import {
  type EventBus,
  type EventEnvelope,
  type EventHandler,
  type EventType,
  baseEnvelopeSchema,
  busChannels,
  streamKeys,
} from '@flytrace/shared';
import type { Redis } from 'ioredis';

/**
 * Redis {@link EventBus} adapter (docs/09 §9.6): every event is XADDed to a
 * durable stream (for consumer groups + WS reconnect replay) and PUBLISHed to
 * pub/sub (for instant fan-out). Publishing goes to both the global and the
 * per-flight channel/stream.
 *
 * Lives in the tracker for now; promote to a shared infra package once the API
 * WS gateway also needs it (both already agree on {@link busChannels} keys).
 */
export class RedisEventBus implements EventBus {
  /** Separate connection: a subscribed connection can't run normal commands. */
  private subscriber: Redis | null = null;
  private readonly handlers = new Map<EventType | '*', Set<EventHandler>>();

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly opts: { eventsMaxLen: number; flightMaxLen: number } = {
      eventsMaxLen: 10_000,
      flightMaxLen: 500,
    },
  ) {}

  private k(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  async publish(event: EventEnvelope): Promise<void> {
    const body = JSON.stringify(event);
    const flightId = event.partitionKey;
    // XADD the per-flight stream first so its entry id can travel with the
    // pub/sub message as `sid` — the WS layer uses it as the reconnect cursor
    // (XRANGE replay), so live `event.id` and replayed ids share one space.
    const sid = await this.redis.xadd(
      this.k(streamKeys.flight(flightId)),
      'MAXLEN',
      '~',
      this.opts.flightMaxLen,
      '*',
      'e',
      body,
    );
    const message = JSON.stringify({ sid, e: event });
    await this.redis
      .multi()
      .xadd(this.k(streamKeys.events), 'MAXLEN', '~', this.opts.eventsMaxLen, '*', 'e', body)
      .publish(this.k(busChannels.events), message)
      .publish(this.k(busChannels.flight(flightId)), message)
      .exec();
  }

  subscribe(type: EventType | '*', handler: EventHandler): () => void {
    const set = this.handlers.get(type) ?? new Set<EventHandler>();
    set.add(handler);
    this.handlers.set(type, set);
    void this.ensureSubscribed();
    return () => {
      set.delete(handler);
    };
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscriber !== null) return;
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(this.k(busChannels.events));
    this.subscriber.on('message', (_channel, message) => {
      const outer = JSON.parse(message) as { sid?: string; e?: unknown };
      const parsed = baseEnvelopeSchema.safeParse(outer.e);
      if (!parsed.success) return;
      const event = parsed.data as EventEnvelope;
      for (const h of [
        ...(this.handlers.get(event.type) ?? []),
        ...(this.handlers.get('*') ?? []),
      ]) {
        void h(event);
      }
    });
  }

  async close(): Promise<void> {
    if (this.subscriber) {
      this.subscriber.disconnect();
      this.subscriber = null;
    }
  }
}
