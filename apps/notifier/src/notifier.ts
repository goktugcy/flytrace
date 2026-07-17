import type { ChannelEndpoint, ChannelKey, WatchlistItem } from '@flytrace/db';
import type { ChannelRegistry, RenderedMessage } from '@flytrace/notifications';
import {
  type Clock,
  type DbEventTypeName,
  type EventEnvelope,
  type Logger,
  type ProviderUpdatedPayload,
  domainToDbEventType,
  systemClock,
} from '@flytrace/shared';
import { renderPush } from './render.ts';
import { type QuietHours, evaluate } from './rules.ts';

const HOUR_MS = 60 * 60 * 1000;

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
  channelEndpoints(userId: string, channel: ChannelKey): Promise<ChannelEndpoint[]>;
  getQuietHours(userId: string): Promise<QuietHours | null>;
  countRecentNotifications(userId: string, flightId: string, sinceIso: string): Promise<number>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  markSuppressed(id: string, reason: string): Promise<void>;
  disableChannel(channelId: string): Promise<void>;
}

export interface NotifierDeps {
  repo: NotifierRepo;
  channels: ChannelRegistry;
  logger: Logger;
  clock?: Clock;
  /** Max non-critical notifications per flight per hour (docs/10 §10.7). */
  frequencyCap?: number;
  /** Called after a notification is delivered (wired to a WS/bus publish). */
  onDelivered?: (userId: string, notificationId: string) => Promise<void>;
}

/**
 * The notification core (docs/10 §10.3): matches a domain event against active
 * watchlist items, then for each (user, event, channel) the user subscribed to,
 * delivers exactly once — the unique dedupe key makes a redelivered event a
 * no-op. Channel-agnostic: it only looks up adapters in the registry. Dead
 * endpoints (410/403) are pruned. Transport-free; tests drive it with fakes.
 */
export class Notifier {
  constructor(private readonly deps: NotifierDeps) {}

  async handle(env: EventEnvelope): Promise<void> {
    // ProviderUpdated fans out into derived sub-events (gate/delay/cancelled/
    // arrived); everything else maps to a single notifiable type (docs/10 §10.3).
    if (env.type === 'ProviderUpdated') {
      for (const derived of deriveFromProviderUpdated(env.payload as ProviderUpdatedPayload)) {
        await this.deliver(env, derived.dbType, derived.message);
      }
      return;
    }
    const dbType = domainToDbEventType(env);
    if (!dbType) return; // positions + lifecycle events are not notifiable
    await this.deliver(env, dbType, renderPush(env, dbType));
  }

  /** Deliver a notifiable (event, type, message) to every matching watcher/channel. */
  private async deliver(
    env: EventEnvelope,
    dbType: DbEventTypeName,
    message: RenderedMessage,
  ): Promise<void> {
    const items = await this.deps.repo.watchesForFlight(env.partitionKey);
    for (const item of items) {
      if (!item.eventTypes.includes(dbType)) continue;
      for (const channelKey of item.channels) {
        if (!this.deps.channels.has(channelKey)) continue; // adapter not enabled
        await this.deliverChannel(env, dbType, message, item, channelKey);
      }
    }
  }

  private async deliverChannel(
    env: EventEnvelope,
    dbType: DbEventTypeName,
    message: RenderedMessage,
    item: WatchlistItem,
    channelKey: ChannelKey,
  ): Promise<void> {
    const dedupeKey = `${item.userId}:${env.dedupeKey}:${dbType}:${channelKey}`;
    const row = await this.deps.repo.insertQueued({
      userId: item.userId,
      watchlistItemId: item.id,
      flightId: env.partitionKey,
      channel: channelKey,
      title: message.title,
      body: message.body,
      payload: env.payload,
      dedupeKey,
    });
    if (!row) return; // duplicate → exactly-once guarantee

    // Quiet hours + frequency cap (critical events bypass both; docs/10 §10.7).
    const nowMs = (this.deps.clock ?? systemClock).now();
    const decision = evaluate({
      dbType,
      nowMs,
      quietHours: await this.deps.repo.getQuietHours(item.userId),
      recentCount: await this.deps.repo.countRecentNotifications(
        item.userId,
        env.partitionKey,
        new Date(nowMs - HOUR_MS).toISOString(),
      ),
      cap: this.deps.frequencyCap ?? 5,
    });
    if (!decision.deliver) {
      await this.deps.repo.markSuppressed(row.id, decision.reason);
      return;
    }

    const endpoints = await this.deps.repo.channelEndpoints(item.userId, channelKey);
    if (endpoints.length === 0) {
      await this.deps.repo.markFailed(row.id, `no active ${channelKey} endpoint`);
      return;
    }

    const channel = this.deps.channels.get(channelKey);
    if (!channel) return;

    let anyOk = false;
    for (const ep of endpoints) {
      const res = await channel.send(ep.address, message);
      if (res.ok) anyOk = true;
      else if (res.gone) {
        this.deps.logger.info('pruning dead endpoint', {
          channel: channelKey,
          channelId: ep.channelId,
        });
        await this.deps.repo.disableChannel(ep.channelId);
      }
    }

    if (anyOk) {
      await this.deps.repo.markSent(row.id);
      await this.deps.onDelivered?.(item.userId, row.id);
    } else {
      await this.deps.repo.markFailed(row.id, `all ${channelKey} sends failed`);
    }
  }
}

/** Derive notifiable sub-events from a provider status change (docs/07 §7.4). */
export function deriveFromProviderUpdated(
  p: ProviderUpdatedPayload,
): { dbType: DbEventTypeName; message: RenderedMessage }[] {
  const out: { dbType: DbEventTypeName; message: RenderedMessage }[] = [];
  const url = `/flights/id/${p.flightId}`;
  for (const field of p.changed) {
    if (field === 'gate' && p.after.gate) {
      out.push({
        dbType: 'gate_change',
        message: { title: 'Gate changed', body: `Now boarding at gate ${p.after.gate}.`, url },
      });
    } else if (field === 'status') {
      if (p.after.status === 'delayed') {
        out.push({
          dbType: 'delay',
          message: { title: 'Delayed', body: 'Your flight is delayed.', url },
        });
      } else if (p.after.status === 'cancelled') {
        out.push({
          dbType: 'cancelled',
          message: { title: 'Cancelled', body: 'Your flight was cancelled.', url },
        });
      } else if (p.after.status === 'landed') {
        out.push({
          dbType: 'arrived',
          message: { title: 'Arrived', body: 'Your flight has arrived.', url },
        });
      }
    }
  }
  return out;
}
