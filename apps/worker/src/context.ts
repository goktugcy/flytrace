import {
  type Database,
  createCatalogRepo,
  createFlightReadRepo,
  createFlightRepo,
  createFlightStatusRepo,
  createPooledDb,
  createSystemRepo,
  resolvePoolConfig,
  sql,
} from '@flytrace/db';
import {
  ProviderRegistry,
  concreteProviderFactories,
  fixtureProviderFactory,
} from '@flytrace/providers';
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
import { AirspaceImportService } from './airspace-import.ts';
import type { WorkerConfig } from './config.ts';
import { StreamConsumer } from './consumer.ts';
import { Persister } from './persist.ts';
import { FetchHttpClient, RedisProviderCache, RedisRateLimiter } from './provider-adapters.ts';
import { ProviderFetchService } from './provider-fetch.ts';
import {
  createAirspaceImportQueue,
  createProviderFetchQueue,
  startAirspaceImportWorker,
  startProviderFetchWorker,
} from './queues.ts';
import { ProviderScheduler } from './scheduler.ts';
import { WatchedFlightMonitor } from './watch-monitor.ts';

export interface WorkerContext {
  config: WorkerConfig;
  logger: Logger;
  db: Database;
  redis: Redis;
  consumer: StreamConsumer;
  providerQueue: Queue;
  airspaceImportQueue: Queue;
  registry: ProviderRegistry;
  close: () => Promise<void>;
}

export async function createContext(config: WorkerConfig): Promise<WorkerContext> {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'worker', env: config.APP_ENV },
  });
  const prefix = redisKeyPrefix(config.APP_ENV);

  const pool = resolvePoolConfig(config);
  logger.info('db pool configured', {
    pool_mode: pool.poolMode,
    max: pool.max,
    prepare: pool.prepare,
    idle_timeout_sec: pool.idleTimeoutSec,
    connect_timeout_sec: pool.connectTimeoutSec,
    max_lifetime_sec: pool.maxLifetimeSec,
    statement_timeout_ms: pool.statementTimeoutMs,
  });
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
  const airspaceImportQueue = createAirspaceImportQueue(bullConnection);

  const catalogRepo = createCatalogRepo(db);

  // Schedule a provider fetch when a flight of a known airline is detected.
  const scheduler = new ProviderScheduler({
    queue: providerQueue,
    catalog: catalogRepo,
    logger,
    ...(config.WORKER_PROVIDER_FETCH_SCOPE === 'watched'
      ? { shouldFetchFlight: (flightId: string) => hasActiveWatch(db, flightId) }
      : {}),
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
    // Per-provider base URLs (compliance/legal basis; docs/08 §8.9), keyed by provider key.
    config: {
      statusUrls: config.WORKER_PROVIDER_STATUS_URLS,
      aerodatabox: {
        apiKey: config.AERODATABOX_API_KEY,
        marketplace: config.AERODATABOX_MARKETPLACE,
        baseUrl: config.AERODATABOX_BASE_URL,
      },
    },
  };
  const fixtureIatas = config.WORKER_FIXTURE_PROVIDER_IATAS;
  // Every real provider is registered; only keys in `enabled` are instantiated.
  // Concrete providers ship disabled — enable via WORKER_ENABLED_PROVIDERS (§8.6).
  const factories = [
    ...concreteProviderFactories(),
    ...(fixtureIatas.length > 0
      ? [fixtureProviderFactory({ key: 'fixture', airlineIata: fixtureIatas })]
      : []),
  ];
  const enabled = new Set<string>(config.WORKER_ENABLED_PROVIDERS);
  if (fixtureIatas.length > 0) enabled.add('fixture');
  if (config.AERODATABOX_API_KEY) enabled.add('aerodatabox');
  const registry = await ProviderRegistry.build(factories, {
    enabled,
    priority: config.WORKER_PROVIDER_PRIORITY,
    ctx: providerCtx,
  });

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

  const systemRepo = createSystemRepo(db);
  const flightRead = createFlightReadRepo(db);
  const providerFetch = new ProviderFetchService({
    registry,
    statusRepo: createFlightStatusRepo(db),
    catalog: createCatalogRepo(db),
    flightRepo: createFlightRepo(db),
    emit,
    clock: providerCtx.clock,
    logger,
    logProvider: (e) => systemRepo.insertProviderLog(e),
    // Outage fallback: coarse status from the aircraft's latest position.
    deriveStatus: async (flightId) => {
      const pos = await flightRead.getLatestPosition(flightId);
      if (!pos) return null;
      return pos.onGround ? 'landed' : 'active';
    },
  });

  // ── BullMQ provider-fetch worker (queue built above; dedicated connection) ──
  const providerWorker = startProviderFetchWorker(bullConnection, providerFetch, logger);
  const airspaceImportWorker = startAirspaceImportWorker(
    bullConnection,
    new AirspaceImportService({ db, config, logger }),
    logger,
  );
  const watchMonitor = config.WATCH_MONITOR_ENABLED
    ? new WatchedFlightMonitor({
        db,
        logger,
        emit,
        options: {
          apiUrl: config.WATCH_MONITOR_ADSB_API_URL,
          intervalMs: config.WATCH_MONITOR_INTERVAL_MS,
          batchSize: config.WATCH_MONITOR_BATCH_SIZE,
          requestDelayMs: config.WATCH_MONITOR_REQUEST_DELAY_MS,
          maxPositionAgeMs: config.WATCH_MONITOR_MAX_POSITION_AGE_MS,
          endAfterMs: config.WATCH_MONITOR_END_AFTER_MS,
        },
      })
    : null;
  watchMonitor?.start();

  return {
    config,
    logger,
    db,
    redis,
    consumer,
    providerQueue,
    airspaceImportQueue,
    registry,
    close: async () => {
      watchMonitor?.stop();
      consumer.stop();
      await airspaceImportWorker.close();
      await providerWorker.close();
      await airspaceImportQueue.close();
      await providerQueue.close();
      bullConnection.disconnect();
      cmdRedis.disconnect();
      redis.disconnect();
      await closeDb();
    },
  };
}

async function hasActiveWatch(db: Database, flightId: string): Promise<boolean> {
  const rows = (await db.execute(sql`
    select 1
    from watchlist_items
    where flight_id = ${flightId}
      and active = true
      and deleted_at is null
    limit 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}
