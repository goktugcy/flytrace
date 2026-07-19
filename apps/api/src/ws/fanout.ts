import { type EventEnvelope, type Logger, baseEnvelopeSchema, busChannels } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { WsHub } from './hub.ts';

/** Wire message published by producers on `rt:events` (see tracker RedisEventBus). */
const busMessageSchema = z.object({ sid: z.string().nullable(), e: baseEnvelopeSchema });

/**
 * Bridges the Redis event bus into the local {@link WsHub}. Subscribes once to
 * the global `rt:events` channel and routes every event to interested sockets.
 *
 * Per-region sharding (`rt:positions:<geohash>`) and per-flight subscriptions
 * are the scaling step (docs/12 §12.8); for now every api node sees every event
 * on one channel — correct, just not yet bandwidth-optimal.
 */
export class RedisFanout {
  private sub: Redis | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly prefix: string,
    private readonly hub: WsHub,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.sub) return;
    this.sub = this.redis.duplicate();
    const channel = `${this.prefix}${busChannels.events}`;
    this.sub.on('error', (err) => {
      this.logger.error('ws fanout redis error', { err: String(err) });
    });
    this.sub.on('reconnecting', () => {
      this.logger.warn('ws fanout redis reconnecting');
    });
    await this.sub.subscribe(channel);
    this.sub.on('message', (_channel, message) => {
      const parsed = busMessageSchema.safeParse(safeJson(message));
      if (!parsed.success) {
        this.logger.warn('fanout: dropped malformed bus message');
        return;
      }
      this.hub.route(parsed.data.sid ?? '0-0', parsed.data.e as EventEnvelope);
    });
    this.logger.info('ws fanout subscribed', { channel });
  }

  async stop(): Promise<void> {
    if (this.sub) {
      this.sub.disconnect();
      this.sub = null;
    }
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
