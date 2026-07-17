import { type Clock, type Logger, createLogger, systemClock } from '@flytrace/shared';
import { Redis } from 'ioredis';
import { RedisEventBus } from './bus/redis-bus.ts';
import type { TrackerConfig } from './config.ts';
import { DEFAULT_DETECTOR_CONFIG } from './domain/flight-state.ts';
import { Tracker, type TrackerOptions } from './engine/tracker.ts';
import { FixturePositionSource } from './source/fixture-source.ts';
import { OpenSkyPositionSource } from './source/opensky-source.ts';
import type { PositionSource } from './source/port.ts';
import { RedisFlightRegistry, RedisFlightStateStore, RedisLock } from './state/redis.ts';

function keyPrefix(appEnv: TrackerConfig['APP_ENV']): string {
  const env = appEnv === 'production' ? 'prod' : appEnv === 'staging' ? 'stg' : 'local';
  return `flytrace:${env}:`;
}

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
  const prefix = keyPrefix(config.APP_ENV);

  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  const store = new RedisFlightStateStore(redis, prefix, config.TRACKER_FLIGHT_TIMEOUT_MS * 2);
  const registry = new RedisFlightRegistry(redis, prefix, config.TRACKER_FLIGHT_TIMEOUT_MS, clock);
  const lock = new RedisLock(redis, prefix, clock);
  const bus = new RedisEventBus(redis, prefix);

  const source = await buildSource(config, logger);

  const options: TrackerOptions = {
    detector: DEFAULT_DETECTOR_CONFIG,
    sourceLabel: source.name,
    flightTimeoutMs: config.TRACKER_FLIGHT_TIMEOUT_MS,
    pollIntervalMs: config.OPENSKY_POLL_INTERVAL_MS,
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

async function buildSource(config: TrackerConfig, logger: Logger): Promise<PositionSource> {
  if (config.TRACKER_USE_FIXTURE) {
    const url = new URL('../fixtures/ist-departure.json', import.meta.url);
    const frames = (await Bun.file(url.pathname).json()) as unknown[];
    logger.info('using fixture position source', { frames: frames.length });
    return new FixturePositionSource(frames);
  }
  return new OpenSkyPositionSource({
    bbox: config.TRACKER_BBOX,
    logger,
    clientId: config.OPENSKY_CLIENT_ID,
    clientSecret: config.OPENSKY_CLIENT_SECRET,
  });
}
