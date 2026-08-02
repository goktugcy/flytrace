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

    /** Update an owner-scoped watch without changing historical notification rows. */
    async updateWatch(
      id: string,
      userId: string,
      patch: {
        eventTypes?: DbEventType[] | undefined;
        channels?: ChannelKey[] | undefined;
        active?: boolean | undefined;
      },
    ): Promise<boolean> {
      const rows = (await db
        .update(watchlistItems)
        .set({
          ...(patch.eventTypes !== undefined ? { eventTypes: patch.eventTypes } : {}),
          ...(patch.channels !== undefined ? { channels: patch.channels } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(watchlistItems.id, id),
            eq(watchlistItems.userId, userId),
            sql`${watchlistItems.deletedAt} is null`,
          ),
        )
        .returning({ id: watchlistItems.id })) as { id: string }[];
      return rows.length > 0;
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
    async watchesForFlight(flightId: string, icao24?: string | null): Promise<WatchlistItem[]> {
      const hex = icao24?.trim().toLowerCase() || null;
      return db.execute(sql`
        select w.id, w.user_id as "userId", w.flight_id as "flightId",
               w.event_types as "eventTypes", w.channels
        from watchlist_items w
        left join flights f on f.id = w.flight_id
        where w.active = true
          and w.deleted_at is null
          and (
            w.flight_id = ${flightId}
            or (
              ${hex}::text is not null
              and f.status = 'active'
              and lower(w.match->>'icao24') = ${hex}
            )
          )
      `) as unknown as Promise<WatchlistItem[]>;
    },

    // ── channels ──
    async upsertWebPush(
      userId: string,
      address: WebPushSubscription['address'],
      replaceEndpoint?: string,
    ): Promise<void> {
      // A browser can retain a local PushSubscription after FCM has expired it.
      // When the client renews that subscription, remove the superseded endpoint
      // without affecting subscriptions belonging to the user's other devices.
      await db.execute(sql`
        delete from notification_channels
        where user_id = ${userId} and channel = 'webpush'
          and (
            address->>'endpoint' = ${address.endpoint}
            or (${replaceEndpoint ?? null}::text is not null
                and address->>'endpoint' = ${replaceEndpoint ?? null})
          )
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
    // Link tokens are one-time bearer credentials: callers pass the SHA-256
    // digest (`hashToken` from @flytrace/shared), never the raw token, and every
    // token carries an explicit expiry. Consumption is a single conditional
    // UPDATE, so it is atomic — a replayed token finds `link_token_hash = null`
    // and matches zero rows.
    /** Create a pending, unverified telegram channel holding a one-time token hash. */
    async createTelegramLink(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
      await db.execute(sql`
        delete from notification_channels
        where user_id = ${userId} and channel = 'telegram' and verified = false
      `);
      await db.insert(notificationChannels).values({
        userId,
        channel: 'telegram',
        address: {},
        verified: false,
        enabled: true,
        linkTokenHash: tokenHash,
        linkTokenExpiresAt: expiresAt,
      });
    },

    /** Bind a chat to the token's user; returns the userId, or null if unknown/expired. */
    async consumeTelegramLink(tokenHash: string, chatId: number | string): Promise<string | null> {
      const rows = (await db.execute(sql`
        update notification_channels
        set address = ${JSON.stringify({ chatId })}::jsonb, verified = true,
            link_token_hash = null, link_token_expires_at = null, updated_at = now()
        where link_token_hash = ${tokenHash} and channel = 'telegram'
          and (link_token_expires_at is null or link_token_expires_at > now())
        returning user_id as "userId"
      `)) as unknown as { userId: string }[];
      return rows[0]?.userId ?? null;
    },

    // ── Email double opt-in ──
    /** Create a pending, unverified email channel holding a verification token hash. */
    async createEmailChannel(
      userId: string,
      email: string,
      tokenHash: string,
      expiresAt: Date,
    ): Promise<void> {
      await db.execute(sql`
        delete from notification_channels
        where user_id = ${userId} and channel = 'email'
          and verified = false
          and lower(address->>'email') = lower(${email})
      `);
      await db.insert(notificationChannels).values({
        userId,
        channel: 'email',
        address: { email },
        verified: false,
        enabled: true,
        linkTokenHash: tokenHash,
        linkTokenExpiresAt: expiresAt,
      });
    },

    /** Verify an email channel by its token hash; returns the userId, or null. */
    async verifyEmailToken(tokenHash: string): Promise<string | null> {
      const rows = (await db.execute(sql`
        update notification_channels
        set verified = true, link_token_hash = null, link_token_expires_at = null,
            updated_at = now()
        where link_token_hash = ${tokenHash} and channel = 'email'
          and (link_token_expires_at is null or link_token_expires_at > now())
        returning user_id as "userId"
      `)) as unknown as { userId: string }[];
      return rows[0]?.userId ?? null;
    },

    /** Housekeeping: clear link tokens whose expiry has passed. */
    async expireStaleLinkTokens(): Promise<number> {
      const rows = (await db.execute(sql`
        update notification_channels
        set link_token_hash = null, link_token_expires_at = null, updated_at = now()
        where link_token_hash is not null and link_token_expires_at <= now()
        returning id
      `)) as unknown as { id: string }[];
      return rows.length;
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

    async updateChannelEnabled(
      channelId: string,
      userId: string,
      enabled: boolean,
    ): Promise<boolean> {
      const rows = (await db
        .update(notificationChannels)
        .set({ enabled, updatedAt: new Date() })
        .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
        .returning({ id: notificationChannels.id })) as { id: string }[];
      return rows.length > 0;
    },

    async deleteChannel(channelId: string, userId: string): Promise<boolean> {
      const rows = (await db
        .delete(notificationChannels)
        .where(and(eq(notificationChannels.id, channelId), eq(notificationChannels.userId, userId)))
        .returning({ id: notificationChannels.id })) as { id: string }[];
      return rows.length > 0;
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

    /** User quiet-hours preference (docs/10 §10.7), or null if unset. */
    async getQuietHours(
      userId: string,
    ): Promise<{ tz: string; start: string; end: string } | null> {
      const rows = (await db.execute(sql`
        select quiet_hours as "quietHours" from user_settings where user_id = ${userId} limit 1
      `)) as unknown as { quietHours: { tz: string; start: string; end: string } | null }[];
      return rows[0]?.quietHours ?? null;
    },

    /** Count a flight's sent notifications since `sinceIso` (frequency cap). */
    async countRecentNotifications(
      userId: string,
      flightId: string,
      sinceIso: string,
    ): Promise<number> {
      const rows = (await db.execute(sql`
        select count(*)::int as n from notifications
        where user_id = ${userId} and flight_id = ${flightId}
          and status = 'sent' and created_at >= ${sinceIso}
      `)) as unknown as { n: number }[];
      return rows[0]?.n ?? 0;
    },

    async markSuppressed(id: string, reason: string): Promise<void> {
      await db
        .update(notifications)
        .set({ status: 'suppressed', error: reason })
        .where(eq(notifications.id, id));
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
        select id, channel, status, title, body, error, payload, flight_id as "flightId",
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
