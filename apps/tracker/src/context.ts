import {
  type Clock,
  type Logger,
  createLogger,
  redisKeyPrefix,
  systemClock,
} from '@flytrace/shared';
import { Redis } from 'ioredis';
import { RedisEventBus } from './bus/redis-bus.ts';
import type { TrackerConfig, TrackerProviderName } from './config.ts';
import { DEFAULT_DETECTOR_CONFIG } from './domain/flight-state.ts';
import { Tracker, type TrackerOptions } from './engine/tracker.ts';
import { AdsbPositionSource } from './source/adsb-source.ts';
import { CompositePositionSource } from './source/composite-source.ts';
import { FixturePositionSource } from './source/fixture-source.ts';
import { OpenSkyPositionSource } from './source/opensky-source.ts';
import type { PositionSource } from './source/port.ts';
import { RedisFlightRegistry, RedisFlightStateStore, RedisLock } from './state/redis.ts';

export interface TrackerContext {
  config: TrackerConfig;
  logger: Logger;
  clock: Clock;
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

  const source = await buildSource(config, logger, clock);

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

  const tracker = new Tracker({ source, store, registry, lock, bus, clock, logger, options });

  return {
    config,
    logger,
    clock,
    tracker,
    bus,
    close: async () => {
      await tracker.stop();
      await bus.close();
      redis.disconnect();
    },
  };
}

async function buildSource(
  config: TrackerConfig,
  logger: Logger,
  clock: Clock,
): Promise<PositionSource> {
  // Explicit fixture flag wins (offline/demo), regardless of TRACKER_SOURCE.
  if (config.TRACKER_USE_FIXTURE || config.TRACKER_SOURCE === 'fixture') {
    const url = new URL('../fixtures/ist-departure.json', import.meta.url);
    const frames = (await Bun.file(url.pathname).json()) as unknown[];
    logger.info('using fixture position source', { frames: frames.length });
    return new FixturePositionSource(frames);
  }
  if (config.TRACKER_SOURCE === 'composite') {
    const sources = config.TRACKER_PROVIDERS.map((provider) =>
      buildLiveSource(provider, config, logger, clock),
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
    });
  }
  return buildLiveSource(config.TRACKER_SOURCE, config, logger, clock);
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
