import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import type { flightEvents } from '../schema/flights.ts';
import { notifications } from '../schema/notifications.ts';
import { notificationChannels, watchlistItems } from '../schema/personalization.ts';

/**
 * Notification-domain persistence: watchlist subscriptions, delivery channels,
 * and the notifications ledger (docs/10). Consumed by apps/api (CRUD) and
 * apps/notifier (matcher + delivery). Exactly-once is enforced by the unique
 * `notifications.dedupe_key`.
 */
export type DbEventType = (typeof flightEvents.type.enumValues)[number];
export type ChannelKey = (typeof notificationChannels.channel.enumValues)[number];

export interface WatchlistItem {
  id: string;
  userId: string;
  flightId: string | null;
  eventTypes: DbEventType[];
  channels: ChannelKey[];
}

export interface WebPushSubscription {
  channelId: string;
  userId: string;
  address: { endpoint: string; keys: { p256dh: string; auth: string } };
}

/** A verified, enabled delivery endpoint for any channel. */
export interface ChannelEndpoint {
  channelId: string;
  userId: string;
  address: Record<string, unknown>;
}

export function createNotifyRepo(db: Database) {
  return {
    // ── watchlist ──
    async createWatch(input: {
      userId: string;
      flightId: string | null;
      match: unknown;
      eventTypes: DbEventType[];
      channels: ChannelKey[];
    }): Promise<{ id: string }> {
      const [row] = await db
        .insert(watchlistItems)
        .values({
          userId: input.userId,
          flightId: input.flightId,
          match: input.match,
          eventTypes: input.eventTypes,
          channels: input.channels,
        })
        .returning({ id: watchlistItems.id });
      return row as { id: string };
    },

    async listWatches(userId: string): Promise<unknown[]> {
      return db.execute(sql`
        select id, flight_id as "flightId", match, event_types as "eventTypes",
               channels, active, created_at as "createdAt"
        from watchlist_items
        where user_id = ${userId} and deleted_at is null
        order by created_at desc
      `) as unknown as unknown[];
    },

    /** Soft-delete, scoped to the owner (returns false if not theirs). */
    async deleteWatch(id: string, userId: string): Promise<boolean> {
      const rows = (await db
        .update(watchlistItems)
        .set({ active: false, deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(watchlistItems.id, id), eq(watchlistItems.userId, userId)))
        .returning({ id: watchlistItems.id })) as { id: string }[];
      return rows.length > 0;
    },

    /** Active watches for a flight (rule matcher entry point). */
    async watchesForFlight(flightId: string): Promise<WatchlistItem[]> {
      return db.execute(sql`
        select id, user_id as "userId", flight_id as "flightId",
               event_types as "eventTypes", channels
        from watchlist_items
        where flight_id = ${flightId} and active = true and deleted_at is null
      `) as unknown as Promise<WatchlistItem[]>;
    },

    // ── channels ──
    async upsertWebPush(userId: string, address: WebPushSubscription['address']): Promise<void> {
      // Replace any existing subscription with the same endpoint for this user.
      await db.execute(sql`
        delete from notification_channels
        where user_id = ${userId} and channel = 'webpush'
          and address->>'endpoint' = ${address.endpoint}
      `);
      await db.insert(notificationChannels).values({
        userId,
        channel: 'webpush',
        address,
        verified: true, // browser permission is the verification for web push
        enabled: true,
      });
    },

    /** Verified + enabled endpoints for a user on one channel (delivery). */
    async channelEndpoints(userId: string, channel: ChannelKey): Promise<ChannelEndpoint[]> {
      return db.execute(sql`
        select id as "channelId", user_id as "userId", address
        from notification_channels
        where user_id = ${userId} and channel = ${channel} and enabled = true and verified = true
      `) as unknown as Promise<ChannelEndpoint[]>;
    },

    // ── Telegram deep-link linking (docs/10 §10.6) ──
    /** Create a pending, unverified telegram channel holding a one-time token. */
    async createTelegramLink(userId: string, token: string): Promise<void> {
      await db.insert(notificationChannels).values({
        userId,
        channel: 'telegram',
        address: {},
        verified: false,
        enabled: true,
        linkToken: token,
      });
    },

    /** Bind a chat to the token's user; returns the userId, or null if unknown. */
    async consumeTelegramLink(token: string, chatId: number | string): Promise<string | null> {
      const rows = (await db.execute(sql`
        update notification_channels
        set address = ${JSON.stringify({ chatId })}::jsonb, verified = true,
            link_token = null, updated_at = now()
        where link_token = ${token} and channel = 'telegram'
        returning user_id as "userId"
      `)) as unknown as { userId: string }[];
      return rows[0]?.userId ?? null;
    },

    // ── Email double opt-in ──
    /** Create a pending, unverified email channel holding a verification token. */
    async createEmailChannel(userId: string, email: string, token: string): Promise<void> {
      await db.insert(notificationChannels).values({
        userId,
        channel: 'email',
        address: { email },
        verified: false,
        enabled: true,
        linkToken: token,
      });
    },

    /** Verify an email channel by its token; returns the userId, or null. */
    async verifyEmailToken(token: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        update notification_channels set verified = true, link_token = null, updated_at = now()
        where link_token = ${token} and channel = 'email'
        returning user_id as "userId"
      `)) as unknown as { userId: string }[];
      return rows[0]?.userId ?? null;
    },

    /** Disable all telegram channels for a chat (the /stop command). */
    async disableTelegramByChat(chatId: number | string): Promise<void> {
      await db.execute(sql`
        update notification_channels set enabled = false, updated_at = now()
        where channel = 'telegram' and address->>'chatId' = ${String(chatId)}
      `);
    },

    async disableChannel(channelId: string): Promise<void> {
      await db
        .update(notificationChannels)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(notificationChannels.id, channelId));
    },

    // ── notifications ledger ──
    /** Insert a queued row; returns null if the dedupe key already exists. */
    async insertQueued(input: {
      userId: string;
      watchlistItemId: string;
      flightId: string | null;
      channel: ChannelKey;
      title: string;
      body: string;
      payload: unknown;
      dedupeKey: string;
    }): Promise<{ id: string } | null> {
      const rows = (await db
        .insert(notifications)
        .values({
          userId: input.userId,
          watchlistItemId: input.watchlistItemId,
          flightId: input.flightId,
          channel: input.channel,
          title: input.title,
          body: input.body,
          payload: input.payload,
          dedupeKey: input.dedupeKey,
        })
        .onConflictDoNothing({ target: notifications.dedupeKey })
        .returning({ id: notifications.id })) as { id: string }[];
      return rows[0] ?? null;
    },

    async markSent(id: string): Promise<void> {
      await db
        .update(notifications)
        .set({ status: 'sent', sentAt: new Date() })
        .where(eq(notifications.id, id));
    },

    async markFailed(id: string, error: string): Promise<void> {
      await db
        .update(notifications)
        .set({ status: 'failed', error })
        .where(eq(notifications.id, id));
    },

    async listForUser(userId: string, limit: number): Promise<unknown[]> {
      return db.execute(sql`
        select id, channel, status, title, body, flight_id as "flightId",
               created_at as "createdAt", sent_at as "sentAt"
        from notifications
        where user_id = ${userId}
        order by created_at desc
        limit ${limit}
      `) as unknown as unknown[];
    },
  };
}

export type NotifyRepo = ReturnType<typeof createNotifyRepo>;
