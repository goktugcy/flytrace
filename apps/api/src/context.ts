import { type Database, createPooledDb, resolvePoolConfig } from '@flytrace/db';
import {
  type Clock,
  type Logger,
  QUEUES,
  createLogger,
  redisKeyPrefix,
  systemClock,
} from '@flytrace/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { ApiConfig } from './config.ts';
import { type ApiMetrics, createApiMetrics } from './metrics.ts';
import {
  type ConnectionRateLimiter,
  InMemoryConnectionRateLimiter,
  InMemoryPresence,
  type PresenceRegistry,
  RedisPresence,
} from './ws/scaling/index.ts';

/**
 * The typed dependency container injected throughout the app (see docs/06 §6.5).
 * Constructed once at bootstrap; adapters can be swapped in tests.
 */
export interface AppContext {
  config: ApiConfig;
  logger: Logger;
  clock: Clock;
  db: Database;
  redis: Redis;
  /** Redis key namespace for this environment (docs/09 §9.2). */
  redisPrefix: string;
  /** BullMQ handle to the provider-fetch queue for admin DLQ browse/retry. */
  providerQueue?: Queue;
  metrics: ApiMetrics;
  wsPresence?: PresenceRegistry;
  wsRateLimiter?: ConnectionRateLimiter;
  close: () => Promise<void>;
}

export function createContext(config: ApiConfig): AppContext {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'api', env: config.APP_ENV },
  });

  const pool = resolvePoolConfig(config);
  ctxLoggerInfoDbPool(logger, pool);
  const { db, close: closeDb } = createPooledDb({
    url: config.DATABASE_URL,
    poolMode: pool.poolMode,
    max: pool.max,
    prepare: pool.prepare,
    idleTimeout: pool.idleTimeoutSec,
    connectTimeout: pool.connectTimeoutSec,
    maxLifetime: pool.maxLifetimeSec,
    statementTimeoutMs: pool.statementTimeoutMs,
  });

  const prefix = redisKeyPrefix(config.APP_ENV);
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  // Dedicated connection for BullMQ management ops (getFailed/retry); BullMQ
  // requires maxRetriesPerRequest=null on its connections.
  const queueConn = redis.duplicate({ maxRetriesPerRequest: null });
  queueConn.on('error', (err) => logger.error('redis(queue) error', { err: String(err) }));
  const providerQueue = new Queue(QUEUES.providerFetch, { connection: queueConn });
  const wsPresence =
    config.WS_PRESENCE_BACKEND === 'redis'
      ? new RedisPresence(redis, prefix, {
          ttlMs: config.WS_HEARTBEAT_INTERVAL_MS * 4,
          clock: systemClock,
        })
      : new InMemoryPresence({
          ttlMs: config.WS_HEARTBEAT_INTERVAL_MS * 4,
          clock: systemClock,
        });
  const wsRateLimiter = new InMemoryConnectionRateLimiter({
    connectCapacity: config.WS_MAX_CONNS_PER_IP,
    messageCapacity: config.WS_MAX_MSGS_PER_SEC,
    clock: systemClock,
  });

  return {
    config,
    logger,
    clock: systemClock,
    db,
    redis,
    redisPrefix: prefix,
    providerQueue,
    metrics: createApiMetrics(),
    wsPresence,
    wsRateLimiter,
    close: async () => {
      await providerQueue.close();
      queueConn.disconnect();
      redis.disconnect();
      await closeDb();
    },
  };
}

function ctxLoggerInfoDbPool(logger: Logger, pool: ReturnType<typeof resolvePoolConfig>): void {
  logger.info('db pool configured', {
    pool_mode: pool.poolMode,
    max: pool.max,
    prepare: pool.prepare,
    idle_timeout_sec: pool.idleTimeoutSec,
    connect_timeout_sec: pool.connectTimeoutSec,
    max_lifetime_sec: pool.maxLifetimeSec,
    statement_timeout_ms: pool.statementTimeoutMs,
  });
}
