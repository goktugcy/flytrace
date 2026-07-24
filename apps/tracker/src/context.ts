import type { AeroFeatureKind, GeoGeometry } from '@flytrace/airport-ops';
import { createAirportGroundReadRepo, createDb } from '@flytrace/db';
import {
  type Clock,
  type Logger,
  createLogger,
  redisKeyPrefix,
  systemClock,
} from '@flytrace/shared';
import { Redis } from 'ioredis';
import {
  type AirportGroundService,
  createAirportGroundService,
} from './airport/airport-ground-service.ts';
import { RedisEventBus } from './bus/redis-bus.ts';
import type { TrackerConfig, TrackerProviderName } from './config.ts';
import { DEFAULT_DETECTOR_CONFIG } from './domain/flight-state.ts';
import { Tracker, type TrackerOptions } from './engine/tracker.ts';
import { type TrackerMetrics, createTrackerMetrics } from './metrics.ts';
import { AdsbPositionSource, type AdsbQueryStyle } from './source/adsb-source.ts';
import { CompositePositionSource } from './source/composite-source.ts';
import { FixturePositionSource } from './source/fixture-source.ts';
import { OpenSkyPositionSource } from './source/opensky-source.ts';
import type { PositionSource } from './source/port.ts';
import { RedisFlightRegistry, RedisFlightStateStore, RedisLock } from './state/redis.ts';

export interface TrackerContext {
  config: TrackerConfig;
  logger: Logger;
  clock: Clock;
  metrics: TrackerMetrics;
  tracker: Tracker;
  bus: RedisEventBus;
  close: () => Promise<void>;
}

export async function createContext(config: TrackerConfig): Promise<TrackerContext> {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'tracker', env: config.APP_ENV },
  });
  const clock = systemClock;
  const metrics = createTrackerMetrics();
  const prefix = redisKeyPrefix(config.APP_ENV);

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  const store = new RedisFlightStateStore(redis, prefix, config.TRACKER_REMOVE_AFTER_MS * 2);
  const registry = new RedisFlightRegistry(redis, prefix, config.TRACKER_REMOVE_AFTER_MS, clock);
  const lock = new RedisLock(redis, prefix, clock);
  const bus = new RedisEventBus(redis, prefix);

  const source = await buildSource(config, logger, clock, metrics);

  const options: TrackerOptions = {
    detector: DEFAULT_DETECTOR_CONFIG,
    sourceLabel: source.name,
    sourceTimeMode: source.timeMode ?? 'wall',
    lifecycle: {
      liveAfterMs: config.TRACKER_LIVE_AFTER_MS,
      delayedAfterMs: config.TRACKER_DELAYED_AFTER_MS,
      staleAfterMs: config.TRACKER_STALE_AFTER_MS,
      removeAfterMs: config.TRACKER_REMOVE_AFTER_MS,
      maxPositionAgeMs: config.TRACKER_MAX_POSITION_AGE_MS,
    },
    pollIntervalMs: pollIntervalMs(config),
    lockName: 'tracker:leader',
    lockTtlMs: config.TRACKER_LOCK_TTL_MS,
  };

  // Airport ground engine (opt-in). Loads geometry from Postgres once at boot.
  let airportGround: AirportGroundService | undefined;
  let closeAirportDb: (() => Promise<void>) | undefined;
  if (config.AIRPORT_GROUND_ENABLED && config.DATABASE_URL) {
    const { db, close } = createDb({ url: config.DATABASE_URL, max: 1 });
    closeAirportDb = close;
    const repo = createAirportGroundReadRepo(db);
    airportGround = await createAirportGroundService({
      listAirports: () => repo.listAirportsWithGeometry(),
      loadFeatures: async (id) =>
        (await repo.byAirportId(id)).map((r) => ({
          id: r.id,
          kind: r.kind as AeroFeatureKind,
          ref: r.ref,
          name: r.name,
          geojson: r.geojson as GeoGeometry | null,
        })),
      maxKm: config.AIRPORT_GROUND_MAX_KM,
      groundAltFt: config.AIRPORT_GROUND_ALT_FT,
      logger,
    });
  }

  const tracker = new Tracker({
    source,
    store,
    registry,
    lock,
    bus,
    clock,
    logger,
    options,
    metrics,
    ...(airportGround ? { airportGround } : {}),
  });

  return {
    config,
    logger,
    clock,
    metrics,
    tracker,
    bus,
    close: async () => {
      await tracker.stop();
      await bus.close();
      if (closeAirportDb) await closeAirportDb();
      redis.disconnect();
    },
  };
}

async function buildSource(
  config: TrackerConfig,
  logger: Logger,
  clock: Clock,
  metrics: TrackerMetrics,
): Promise<PositionSource> {
  // Explicit fixture flag wins (offline/demo), regardless of TRACKER_SOURCE.
  if (config.TRACKER_USE_FIXTURE || config.TRACKER_SOURCE === 'fixture') {
    const url = new URL('../fixtures/ist-departure.json', import.meta.url);
    const frames = (await Bun.file(url.pathname).json()) as unknown[];
    logger.info('using fixture position source', { frames: frames.length });
    return new FixturePositionSource(frames);
  }
  if (config.TRACKER_SOURCE === 'composite') {
    // 'adsb' expands to one source per configured feed (ADSB_FEEDS); others map
    // 1:1. The composite dedups by icao24 and keeps the best-scored candidate,
    // so overlapping feeds never double-plot.
    const sources = config.TRACKER_PROVIDERS.flatMap((provider) =>
      provider === 'adsb'
        ? buildAdsbSources(config, logger, clock)
        : [buildLiveSource(provider, config, logger, clock)],
    );
    logger.info('using composite position source', { providers: config.TRACKER_PROVIDERS });
    return new CompositePositionSource({
      sources,
      logger,
      clock,
      maxPositionAgeMs: config.TRACKER_MAX_POSITION_AGE_MS,
      switchMargin: config.TRACKER_PROVIDER_SWITCH_MARGIN,
      maxJumpSpeedKt: config.TRACKER_PROVIDER_MAX_JUMP_SPEED_KT,
      providerPriority: config.TRACKER_PROVIDER_PRIORITY,
      metrics,
    });
  }
  return buildLiveSource(config.TRACKER_SOURCE, config, logger, clock);
}

/** Parse ADSB_FEEDS ("url|style,url|style"), falling back to the single feed. */
function adsbFeeds(config: TrackerConfig): { apiUrl: string; queryStyle: AdsbQueryStyle }[] {
  const raw = config.ADSB_FEEDS?.trim();
  if (raw) {
    const feeds = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const [url, style] = entry.split('|').map((s) => s.trim());
        return {
          apiUrl: url ?? '',
          queryStyle: (style === 'point' ? 'point' : 'lol') as AdsbQueryStyle,
        };
      })
      .filter((f) => f.apiUrl.length > 0);
    if (feeds.length > 0) return feeds;
  }
  return [{ apiUrl: config.ADSB_API_URL, queryStyle: config.ADSB_QUERY_STYLE }];
}

/** One ADS-B source per configured feed (all named 'adsb', so priority/scoring apply uniformly). */
function buildAdsbSources(
  config: TrackerConfig,
  logger: Logger,
  clock: Clock,
): AdsbPositionSource[] {
  const feeds = adsbFeeds(config);
  logger.info('using adsb position source(s)', {
    feeds: feeds.map((f) => f.apiUrl),
    center: [config.ADSB_CENTER_LAT, config.ADSB_CENTER_LON],
    radiusNm: config.ADSB_RADIUS_NM,
  });
  return feeds.map(
    (f) =>
      new AdsbPositionSource({
        apiUrl: f.apiUrl,
        lat: config.ADSB_CENTER_LAT,
        lon: config.ADSB_CENTER_LON,
        radiusNm: config.ADSB_RADIUS_NM,
        queryStyle: f.queryStyle,
        logger,
        clock,
      }),
  );
}

function buildLiveSource(
  provider: TrackerProviderName,
  config: TrackerConfig,
  logger: Logger,
  clock: Clock,
): PositionSource {
  if (provider === 'opensky') {
    logger.info('using opensky position source', { bbox: config.TRACKER_BBOX });
    return new OpenSkyPositionSource({
      bbox: config.TRACKER_BBOX,
      logger,
      clientId: config.OPENSKY_CLIENT_ID,
      clientSecret: config.OPENSKY_CLIENT_SECRET,
      clock,
      // In composite mode the engine ticks on the fast (adsb) interval; keep
      // OpenSky on its own credit-safe cadence and never let it stall the tick.
      minFetchIntervalMs: config.OPENSKY_POLL_INTERVAL_MS,
      fetchTimeoutMs: 25_000,
    });
  }
  logger.info('using adsb position source', {
    api: config.ADSB_API_URL,
    center: [config.ADSB_CENTER_LAT, config.ADSB_CENTER_LON],
    radiusNm: config.ADSB_RADIUS_NM,
  });
  return new AdsbPositionSource({
    apiUrl: config.ADSB_API_URL,
    lat: config.ADSB_CENTER_LAT,
    lon: config.ADSB_CENTER_LON,
    radiusNm: config.ADSB_RADIUS_NM,
    queryStyle: config.ADSB_QUERY_STYLE,
    logger,
    clock,
  });
}

function pollIntervalMs(config: TrackerConfig): number {
  if (config.TRACKER_SOURCE === 'adsb') return config.ADSB_POLL_INTERVAL_MS;
  if (config.TRACKER_SOURCE === 'opensky') return config.OPENSKY_POLL_INTERVAL_MS;
  if (config.TRACKER_SOURCE !== 'composite') return config.OPENSKY_POLL_INTERVAL_MS;
  const intervals = config.TRACKER_PROVIDERS.map((provider) =>
    provider === 'adsb' ? config.ADSB_POLL_INTERVAL_MS : config.OPENSKY_POLL_INTERVAL_MS,
  );
  return Math.min(...intervals);
}
