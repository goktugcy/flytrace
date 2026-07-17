import { type Database, createDb, createNotifyRepo } from '@flytrace/db';
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
import { FakePushSender } from './push/fake-sender.ts';
import type { PushSender } from './push/port.ts';
import { WebPushSender } from './push/web-push-sender.ts';

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

  const sender = buildSender(config, logger);
  const repo = createNotifyRepo(db);

  // On delivery, announce NotificationSent on the bus (dashboard feed; docs/10 §10.3).
  const onDelivered = async (userId: string, notificationId: string): Promise<void> => {
    const env = makeEnvelope(
      {
        type: 'NotificationSent',
        occurredAt: new Date().toISOString(),
        dedupeKey: `${notificationId}:sent`,
        partitionKey: userId,
        payload: { notificationId, userId, channel: 'webpush', status: 'sent' },
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

  const notifier = new Notifier({ repo, sender, logger, onDelivered });
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

function buildSender(config: NotifierConfig, logger: Logger): PushSender {
  const haveVapid = Boolean(config.WEB_PUSH_PUBLIC_KEY && config.WEB_PUSH_PRIVATE_KEY);
  if (config.NOTIFIER_FAKE_PUSH || !haveVapid) {
    logger.warn('using fake push sender', {
      reason: config.NOTIFIER_FAKE_PUSH ? 'flag' : 'no VAPID keys',
    });
    return new FakePushSender();
  }
  return new WebPushSender({
    publicKey: config.WEB_PUSH_PUBLIC_KEY as string,
    privateKey: config.WEB_PUSH_PRIVATE_KEY as string,
    subject: config.WEB_PUSH_SUBJECT,
  });
}
