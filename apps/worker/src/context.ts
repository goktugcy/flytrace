import {
  type Database,
  createCatalogRepo,
  createDb,
  createFlightRepo,
  createFlightStatusRepo,
} from '@flytrace/db';
import { ProviderRegistry, fixtureProviderFactory } from '@flytrace/providers';
import {
  type EventEnvelope,
  type Logger,
  busChannels,
  createLogger,
  redisKeyPrefix,
  streamKeys,
} from '@flytrace/shared';
import type { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { WorkerConfig } from './config.ts';
import { StreamConsumer } from './consumer.ts';
import { Persister } from './persist.ts';
import { FetchHttpClient, RedisProviderCache, RedisRateLimiter } from './provider-adapters.ts';
import { ProviderFetchService } from './provider-fetch.ts';
import { createProviderFetchQueue, startProviderFetchWorker } from './queues.ts';
import { ProviderScheduler } from './scheduler.ts';

export interface WorkerContext {
  config: WorkerConfig;
  logger: Logger;
  db: Database;
  redis: Redis;
  consumer: StreamConsumer;
  providerQueue: Queue;
  registry: ProviderRegistry;
  close: () => Promise<void>;
}

export async function createContext(config: WorkerConfig): Promise<WorkerContext> {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'worker', env: config.APP_ENV },
  });
  const prefix = redisKeyPrefix(config.APP_ENV);

  const { db, close: closeDb } = createDb({ url: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // required for blocking XREADGROUP + BullMQ
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  // Dedicated non-blocking connection: the stream consumer holds `redis` on a
  // blocking XREADGROUP, which would starve provider cache/rate-limit + publish
  // commands if they shared it. (docs/09 §9.1 — separate blocking connections.)
  const cmdRedis = redis.duplicate();
  cmdRedis.on('error', (err) => logger.error('redis(cmd) error', { err: String(err) }));

  // ── BullMQ provider-fetch queue (dedicated connection) ──
  const bullConnection = redis.duplicate();
  const providerQueue = createProviderFetchQueue(bullConnection);

  // Schedule a provider fetch when a flight of a known airline is detected.
  const scheduler = new ProviderScheduler({
    queue: providerQueue,
    catalog: createCatalogRepo(db),
    logger,
  });

  // ── Persistence pipeline (stream consumer) ──
  const persister = new Persister(createFlightRepo(db), logger, {
    maxPositionBatch: config.WORKER_MAX_POSITION_BATCH,
  });
  const consumer = new StreamConsumer(
    redis,
    prefix,
    persister,
    logger,
    {
      group: config.WORKER_GROUP,
      consumer: config.WORKER_CONSUMER,
      batchSize: config.WORKER_BATCH_SIZE,
      blockMs: config.WORKER_BLOCK_MS,
    },
    (env) => scheduler.onEvent(env),
  );

  // ── Provider registry (docs/08) ──
  const providerCtx = {
    http: new FetchHttpClient(),
    cache: new RedisProviderCache(cmdRedis, prefix),
    rateLimiter: new RedisRateLimiter(cmdRedis, `${prefix}provider:rl:`, {
      limit: 30,
      windowMs: 60_000,
    }),
    logger,
    clock: { now: Date.now, nowIso: () => new Date().toISOString() },
    config: {},
  };
  const fixtureIatas = config.WORKER_FIXTURE_PROVIDER_IATAS;
  const registry = await ProviderRegistry.build(
    fixtureIatas.length > 0
      ? [fixtureProviderFactory({ key: 'fixture', airlineIata: fixtureIatas })]
      : [],
    { enabled: new Set(fixtureIatas.length > 0 ? ['fixture'] : []), ctx: providerCtx },
  );

  // Publish domain events on the bus (durable stream + pub/sub), like the tracker.
  const emit = async (env: EventEnvelope): Promise<void> => {
    const body = JSON.stringify(env);
    const sid = await cmdRedis.xadd(
      `${prefix}${streamKeys.flight(env.partitionKey)}`,
      'MAXLEN',
      '~',
      500,
      '*',
      'e',
      body,
    );
    const message = JSON.stringify({ sid, e: env });
    await cmdRedis
      .multi()
      .xadd(`${prefix}${streamKeys.events}`, 'MAXLEN', '~', 10_000, '*', 'e', body)
      .publish(`${prefix}${busChannels.events}`, message)
      .publish(`${prefix}${busChannels.flight(env.partitionKey)}`, message)
      .exec();
  };

  const providerFetch = new ProviderFetchService({
    registry,
    statusRepo: createFlightStatusRepo(db),
    emit,
    clock: providerCtx.clock,
    logger,
  });

  // ── BullMQ provider-fetch worker (queue built above; dedicated connection) ──
  const providerWorker = startProviderFetchWorker(bullConnection, providerFetch, logger);

  return {
    config,
    logger,
    db,
    redis,
    consumer,
    providerQueue,
    registry,
    close: async () => {
      consumer.stop();
      await providerWorker.close();
      await providerQueue.close();
      bullConnection.disconnect();
      cmdRedis.disconnect();
      redis.disconnect();
      await closeDb();
    },
  };
}
