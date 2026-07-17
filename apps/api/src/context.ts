import { type Database, createDb } from '@flytrace/db';
import { type Clock, type Logger, createLogger, systemClock } from '@flytrace/shared';
import { Redis } from 'ioredis';
import type { ApiConfig } from './config.ts';

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
  close: () => Promise<void>;
}

export function createContext(config: ApiConfig): AppContext {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'api', env: config.APP_ENV },
  });

  const { db, close: closeDb } = createDb({ url: config.DATABASE_URL });

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  return {
    config,
    logger,
    clock: systemClock,
    db,
    redis,
    close: async () => {
      redis.disconnect();
      await closeDb();
    },
  };
}
