import type { ChannelKey, WatchlistItem, WebPushSubscription } from '@flytrace/db';
import { type EventEnvelope, type Logger, domainToDbEventType } from '@flytrace/shared';
import type { PushSender } from './push/port.ts';
import { renderPush } from './render.ts';

/** The slice of the notify repo the core needs (full NotifyRepo satisfies it). */
export interface NotifierRepo {
  watchesForFlight(flightId: string): Promise<WatchlistItem[]>;
  insertQueued(input: {
    userId: string;
    watchlistItemId: string;
    flightId: string | null;
    channel: ChannelKey;
    title: string;
    body: string;
    payload: unknown;
    dedupeKey: string;
  }): Promise<{ id: string } | null>;
  webPushSubscriptions(userId: string): Promise<WebPushSubscription[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  disableChannel(channelId: string): Promise<void>;
}

export interface NotifierDeps {
  repo: NotifierRepo;
  sender: PushSender;
  logger: Logger;
  /** Called after a notification is delivered (wired to a WS/bus publish). */
  onDelivered?: (userId: string, notificationId: string) => Promise<void>;
}

/**
 * The notification core (docs/10 §10.3): matches a domain event against active
 * watchlist items, then for each (user, event, webpush) delivers exactly once —
 * the unique dedupe key on the notifications ledger makes a redelivered event a
 * no-op. Dead subscriptions (410/404) are pruned. Pure of transport: the Redis
 * consumer drives it, and tests drive it with fakes.
 */
export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  async handle(env: EventEnvelope): Promise<void> {
    const dbType = domainToDbEventType(env);
    if (!dbType) return; // positions + lifecycle events are not notifiable

    const flightId = env.partitionKey;
    const items = await this.deps.repo.watchesForFlight(flightId);
    if (items.length === 0) return;

    const msg = renderPush(env, dbType);

    for (const item of items) {
      if (!item.eventTypes.includes(dbType)) continue;
      if (!item.channels.includes('webpush')) continue; // v1: Web Push only

      const dedupeKey = `${item.userId}:${env.dedupeKey}:webpush`;
      const row = await this.deps.repo.insertQueued({
        userId: item.userId,
        watchlistItemId: item.id,
        flightId,
        channel: 'webpush',
        title: msg.title,
        body: msg.body,
        payload: env.payload,
        dedupeKey,
      });
      if (!row) continue; // duplicate → exactly-once guarantee

      const subs = await this.deps.repo.webPushSubscriptions(item.userId);
      if (subs.length === 0) {
        await this.deps.repo.markFailed(row.id, 'no active web push subscription');
        continue;
      }

      let anyOk = false;
      for (const sub of subs) {
        const res = await this.deps.sender.send(sub.address, msg);
        if (res.ok) anyOk = true;
        else if (res.gone) {
          this.deps.logger.info('pruning dead web push subscription', { channelId: sub.channelId });
          await this.deps.repo.disableChannel(sub.channelId);
        }
      }

      if (anyOk) {
        await this.deps.repo.markSent(row.id);
        await this.deps.onDelivered?.(item.userId, row.id);
      } else {
        await this.deps.repo.markFailed(row.id, 'all web push sends failed');
      }
    }
  }
}
