import { type Database, createDb, createNotifyRepo } from '@flytrace/db';
import {
  ChannelRegistry,
  EmailChannel,
  FakeChannel,
  HttpEmailTransport,
  TelegramChannel,
  WebPushChannel,
} from '@flytrace/notifications';
import {
  type Logger,
  busChannels,
  createLogger,
  makeEnvelope,
  redisKeyPrefix,
} from '@flytrace/shared';
import { Redis } from 'ioredis';
import type { NotifierConfig } from './config.ts';
import { StreamConsumer } from './consumer.ts';
import { Notifier } from './notifier.ts';

export interface NotifierContext {
  config: NotifierConfig;
  logger: Logger;
  db: Database;
  redis: Redis;
  consumer: StreamConsumer;
  close: () => Promise<void>;
}

export function createContext(config: NotifierConfig): NotifierContext {
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'notifier', env: config.APP_ENV },
  });
  const prefix = redisKeyPrefix(config.APP_ENV);

  const { db, close: closeDb } = createDb({ url: config.DATABASE_URL });
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null, // blocking XREADGROUP
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  redis.on('error', (err) => logger.error('redis error', { err: String(err) }));

  const channels = buildChannels(config, logger);
  const repo = createNotifyRepo(db);

  // On delivery, announce NotificationSent on the bus (dashboard feed; docs/10 §10.3).
  const onDelivered = async (userId: string, notificationId: string): Promise<void> => {
    const env = makeEnvelope(
      {
        type: 'NotificationSent',
        occurredAt: new Date().toISOString(),
        dedupeKey: `${notificationId}:sent`,
        partitionKey: userId,
        payload: { notificationId, userId, status: 'sent' },
      },
      { producer: 'notifier' },
    );
    const message = JSON.stringify({ sid: '0-0', e: env });
    await redis
      .multi()
      .publish(`${prefix}${busChannels.events}`, message)
      .publish(`${prefix}rt:notifications:${userId}`, message)
      .exec();
  };

  const notifier = new Notifier({
    repo,
    channels,
    logger,
    onDelivered,
    frequencyCap: config.NOTIFIER_FREQUENCY_CAP,
  });
  const consumer = new StreamConsumer(redis, prefix, notifier, logger, {
    group: config.NOTIFIER_GROUP,
    consumer: config.NOTIFIER_CONSUMER,
    batchSize: config.NOTIFIER_BATCH_SIZE,
    blockMs: config.NOTIFIER_BLOCK_MS,
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

/** Build the channel registry from config (docs/10 §10.1). Fake channels power
 * offline dev / the pipeline smoke; real adapters activate when configured. */
function buildChannels(config: NotifierConfig, logger: Logger): ChannelRegistry {
  const registry = new ChannelRegistry();
  if (config.NOTIFIER_FAKE_PUSH) {
    logger.warn('using fake channels (NOTIFIER_FAKE_PUSH)');
    return registry
      .register(new FakeChannel('webpush'))
      .register(new FakeChannel('telegram'))
      .register(new FakeChannel('email'));
  }
  if (config.WEB_PUSH_PUBLIC_KEY && config.WEB_PUSH_PRIVATE_KEY) {
    registry.register(
      new WebPushChannel({
        publicKey: config.WEB_PUSH_PUBLIC_KEY,
        privateKey: config.WEB_PUSH_PRIVATE_KEY,
        subject: config.WEB_PUSH_SUBJECT,
      }),
    );
  }
  if (config.TELEGRAM_BOT_TOKEN) {
    registry.register(
      new TelegramChannel({ token: config.TELEGRAM_BOT_TOKEN, webBaseUrl: config.WEB_BASE_URL }),
    );
  }
  if (config.EMAIL_API_KEY) {
    registry.register(
      new EmailChannel({
        from: config.EMAIL_FROM,
        webBaseUrl: config.WEB_BASE_URL,
        transport: new HttpEmailTransport({
          apiKey: config.EMAIL_API_KEY,
          apiUrl: config.EMAIL_API_URL,
        }),
      }),
    );
  }
  logger.info('channels enabled', { channels: registry.keys() });
  return registry;
}
