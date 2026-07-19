import {
  type AdapterFactory,
  type Clock,
  type Logger,
  selectAdapter,
  systemClock,
} from '@flytrace/shared';
import type { Redis } from 'ioredis';

/**
 * Presence registry for a connected-client count / listing API (docs/12 §12.8).
 *
 * The DEFAULT is {@link InMemoryPresence} (per-node, exact for a single api node);
 * {@link RedisPresence} is env-gated and aggregates presence across every node
 * using a sorted set (score = expiry) plus a hash of metadata, with a TTL sweep
 * so crashed connections self-expire. Both share the {@link PresenceRegistry}
 * port, so the presence endpoint never binds to a backend.
 */
export interface PresenceMeta {
  uid?: string | null;
  role?: string;
  /** Free-form tags (viewport shard, region, client build, …). */
  [key: string]: unknown;
}

export interface PresenceEntry {
  connId: string;
  meta: PresenceMeta;
}

export interface PresenceRegistry {
  /** Register (or refresh) a connection with its metadata. */
  join(connId: string, meta: PresenceMeta): Promise<void>;
  /** Remove a connection. */
  leave(connId: string): Promise<void>;
  /** Current connected count (excludes expired entries). */
  count(): Promise<number>;
  /** Snapshot of connected clients (excludes expired entries). */
  list(): Promise<PresenceEntry[]>;
}

export interface PresenceOptions {
  /** Entry lifetime in ms; a connection must re-join within this to stay live. */
  ttlMs?: number;
  clock?: Clock;
}

const DEFAULT_TTL_MS = 60_000;

/**
 * Single-node registry. Entries expire lazily on read (count/list) using the
 * injected clock, so a dropped connection that never called `leave` is pruned.
 */
export class InMemoryPresence implements PresenceRegistry {
  private readonly entries = new Map<string, { meta: PresenceMeta; exp: number }>();
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(opts: PresenceOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? systemClock;
  }

  async join(connId: string, meta: PresenceMeta): Promise<void> {
    this.entries.set(connId, { meta, exp: this.clock.now() + this.ttlMs });
  }

  async leave(connId: string): Promise<void> {
    this.entries.delete(connId);
  }

  private prune(): void {
    const now = this.clock.now();
    for (const [id, entry] of this.entries) {
      if (entry.exp <= now) this.entries.delete(id);
    }
  }

  async count(): Promise<number> {
    this.prune();
    return this.entries.size;
  }

  async list(): Promise<PresenceEntry[]> {
    this.prune();
    return [...this.entries].map(([connId, { meta }]) => ({ connId, meta }));
  }
}

/**
 * Cross-node registry. `<prefix>presence:conns` is a sorted set scored by each
 * entry's expiry ms; `<prefix>presence:meta` is a hash of connId → JSON meta.
 * Every read first sweeps expired members (`ZREMRANGEBYSCORE -inf (now`), so a
 * node that died without calling `leave` drops out after `ttlMs`.
 */
export class RedisPresence implements PresenceRegistry {
  private readonly setKey: string;
  private readonly metaKey: string;
  private readonly ttlMs: number;
  private readonly clock: Clock;

  constructor(
    private readonly redis: Redis,
    prefix = '',
    opts: PresenceOptions = {},
  ) {
    this.setKey = `${prefix}presence:conns`;
    this.metaKey = `${prefix}presence:meta`;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.clock = opts.clock ?? systemClock;
  }

  async join(connId: string, meta: PresenceMeta): Promise<void> {
    const exp = this.clock.now() + this.ttlMs;
    await this.redis
      .multi()
      .zadd(this.setKey, exp, connId)
      .hset(this.metaKey, connId, JSON.stringify(meta))
      .exec();
  }

  async leave(connId: string): Promise<void> {
    await this.redis.multi().zrem(this.setKey, connId).hdel(this.metaKey, connId).exec();
  }

  private async sweep(): Promise<void> {
    const cutoff = this.clock.now();
    const stale = await this.redis.zrangebyscore(this.setKey, '-inf', `(${cutoff}`);
    if (stale.length === 0) return;
    const tx = this.redis.multi().zrem(this.setKey, ...stale);
    for (const id of stale) tx.hdel(this.metaKey, id);
    await tx.exec();
  }

  async count(): Promise<number> {
    await this.sweep();
    return this.redis.zcard(this.setKey);
  }

  async list(): Promise<PresenceEntry[]> {
    await this.sweep();
    const ids = await this.redis.zrange(this.setKey, 0, -1);
    if (ids.length === 0) return [];
    const metas = await this.redis.hmget(this.metaKey, ...ids);
    return ids.map((connId, i) => ({ connId, meta: parseMeta(metas[i]) }));
  }
}

function parseMeta(raw: string | null | undefined): PresenceMeta {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as PresenceMeta) : {};
  } catch {
    return {};
  }
}

export interface CreatePresenceOptions extends PresenceOptions {
  /** `WS_PRESENCE_BACKEND`: 'memory' (default) | 'redis'. */
  backend?: string | undefined;
  redis?: Redis | undefined;
  prefix?: string | undefined;
  logger?: Logger | undefined;
}

/**
 * Resolve the configured presence registry, defaulting to in-memory. 'redis' is
 * only offered when a connection is supplied, so it degrades to memory rather
 * than failing when Redis is absent.
 */
export function createPresence(opts: CreatePresenceOptions = {}): Promise<PresenceRegistry> {
  const base: PresenceOptions = {
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  };
  const prefix = opts.prefix ?? '';
  const logger = opts.logger;
  const adapters: Record<string, AdapterFactory<PresenceRegistry>> = {
    memory: () => new InMemoryPresence(base),
  };
  if (opts.redis) {
    const redis = opts.redis;
    adapters.redis = () => new RedisPresence(redis, prefix, base);
  }
  return selectAdapter<PresenceRegistry>({
    label: 'ws:presence',
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
