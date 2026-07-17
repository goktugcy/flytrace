import { type Database, createDb, createFlightRepo } from '@flytrace/db';
import { type Logger, createLogger, redisKeyPrefix } from '@flytrace/shared';
import { Redis } from 'ioredis';
import type { WorkerConfig } from './config.ts';
import { StreamConsumer } from './consumer.ts';
import { Persister } from './persist.ts';

export interface WorkerContext {
  config: WorkerConfig;
  logger: Logger;
  db: Database;
  redis: Redis;
  consumer: StreamConsumer;
  close: () => Promise<void>;
}

export function createContext(config: WorkerConfig): WorkerContext {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'worker', env: config.APP_ENV },
  });
  const prefix = redisKeyPrefix(config.APP_ENV);

  const { db, close: closeDb } = createDb({ url: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required for blocking XREADGROUP
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  const repo = createFlightRepo(db);
  const persister = new Persister(repo, logger, {
    maxPositionBatch: config.WORKER_MAX_POSITION_BATCH,
  });
  const consumer = new StreamConsumer(redis, prefix, persister, logger, {
    group: config.WORKER_GROUP,
    consumer: config.WORKER_CONSUMER,
    batchSize: config.WORKER_BATCH_SIZE,
    blockMs: config.WORKER_BLOCK_MS,
  });

  return {
    config,
    logger,
    db,
    redis,
    consumer,
    close: async () => {
      consumer.stop();
      redis.disconnect();
      await closeDb();
    },
  };
}
