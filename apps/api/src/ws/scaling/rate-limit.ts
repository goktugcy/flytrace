import {
  type AdapterFactory,
  type Clock,
  type Logger,
  selectAdapter,
  systemClock,
} from '@flytrace/shared';

/**
 * Connection rate limiting for the WebSocket edge (docs/12 §12.8): a per-IP
 * limit on the connect/handshake rate and a per-connection limit on the inbound
 * message rate, both as token buckets so short bursts are tolerated while the
 * sustained rate is capped.
 *
 * The DEFAULT is {@link InMemoryConnectionRateLimiter} (per-node, zero deps).
 * A distributed Redis limiter is optional/env-gated; the port is sync (the hub
 * checks it on every inbound frame), so a Redis variant would front this local
 * bucket rather than replace it. The clock is injected for deterministic tests.
 */
export interface ConnectionRateLimiter {
  /** True if a new connection from `ip` is allowed now (consumes a token). */
  allowConnect(ip: string): boolean;
  /** True if an inbound message on `connId` is allowed now (consumes a token). */
  allowMessage(connId: string): boolean;
  /** Release per-connection state when a connection closes. */
  release(connId: string): void;
}

/** A single token bucket: `capacity` tokens, refilled at `refillPerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly clock: Clock,
  ) {
    this.tokens = capacity;
    this.last = clock.now();
  }

  /** Attempt to remove one token; returns false when the bucket is empty. */
  tryRemove(): boolean {
    const now = this.clock.now();
    const elapsedSec = Math.max(0, (now - this.last) / 1000);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export interface RateLimitOptions {
  /** Per-IP connect burst capacity (config `WS_MAX_CONNS_PER_IP`). */
  connectCapacity: number;
  /** Per-IP sustained connects/sec (defaults to `connectCapacity`). */
  connectRefillPerSec?: number;
  /** Per-connection message burst capacity (config `WS_MAX_MSGS_PER_SEC`). */
  messageCapacity: number;
  /** Per-connection sustained messages/sec (defaults to `messageCapacity`). */
  messageRefillPerSec?: number;
  clock?: Clock;
}

/**
 * Per-node token-bucket limiter. Connect buckets are keyed by IP and message
 * buckets by connection id; both are created lazily. `release` drops the
 * message bucket on close so long-lived processes don't accumulate entries
 * (connect buckets are few — one per active source IP — and left to refill).
 */
export class InMemoryConnectionRateLimiter implements ConnectionRateLimiter {
  private readonly connectBuckets = new Map<string, TokenBucket>();
  private readonly messageBuckets = new Map<string, TokenBucket>();
  private readonly clock: Clock;
  private readonly connectCapacity: number;
  private readonly connectRefill: number;
  private readonly messageCapacity: number;
  private readonly messageRefill: number;

  constructor(opts: RateLimitOptions) {
    this.clock = opts.clock ?? systemClock;
    this.connectCapacity = opts.connectCapacity;
    this.connectRefill = opts.connectRefillPerSec ?? opts.connectCapacity;
    this.messageCapacity = opts.messageCapacity;
    this.messageRefill = opts.messageRefillPerSec ?? opts.messageCapacity;
  }

  allowConnect(ip: string): boolean {
    let bucket = this.connectBuckets.get(ip);
    if (!bucket) {
      bucket = new TokenBucket(this.connectCapacity, this.connectRefill, this.clock);
      this.connectBuckets.set(ip, bucket);
    }
    return bucket.tryRemove();
  }

  allowMessage(connId: string): boolean {
    let bucket = this.messageBuckets.get(connId);
    if (!bucket) {
      bucket = new TokenBucket(this.messageCapacity, this.messageRefill, this.clock);
      this.messageBuckets.set(connId, bucket);
    }
    return bucket.tryRemove();
  }

  release(connId: string): void {
    this.messageBuckets.delete(connId);
  }
}

export interface CreateRateLimiterOptions {
  /** Per-IP connect capacity (config `WS_MAX_CONNS_PER_IP`). */
  maxConnsPerIp: number;
  /** Per-connection message rate (config `WS_MAX_MSGS_PER_SEC`). */
  maxMsgsPerSec: number;
  /** `WS_RATELIMIT_BACKEND`: 'memory' (default). Reserved for a future 'redis'. */
  backend?: string | undefined;
  clock?: Clock | undefined;
  logger?: Logger | undefined;
}

/**
 * Resolve the configured connection rate limiter, defaulting to the in-memory
 * token-bucket. An unknown backend degrades to memory (never throws).
 */
export function createRateLimiter(opts: CreateRateLimiterOptions): Promise<ConnectionRateLimiter> {
  const base: RateLimitOptions = {
    connectCapacity: opts.maxConnsPerIp,
    messageCapacity: opts.maxMsgsPerSec,
    ...(opts.clock ? { clock: opts.clock } : {}),
  };
  const logger = opts.logger;
  const adapters: Record<string, AdapterFactory<ConnectionRateLimiter>> = {
    memory: () => new InMemoryConnectionRateLimiter(base),
  };
  return selectAdapter<ConnectionRateLimiter>({
    label: 'ws:rate-limit',
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
