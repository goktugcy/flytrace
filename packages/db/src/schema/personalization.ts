import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channel, eventType, favoriteKind } from './_enums.ts';
import { users } from './auth.ts';
import { flights } from './flights.ts';

/** Watchlist items — "track this flight and notify me" (the core subscription). */
export const watchlistItems = pgTable(
  'watchlist_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    flightId: uuid('flight_id').references(() => flights.id, { onDelete: 'set null' }),
    match: jsonb('match').notNull(),
    eventTypes: eventType('event_types').array().notNull(),
    channels: channel('channels').array().notNull(),
    active: boolean('active').notNull().default(true),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_watchlist_user_active').on(t.userId, t.active),
    index('idx_watchlist_flight_active').on(t.flightId).where(sql`${t.active} = true`),
  ],
);

/** Favorites — quick access to routes / aircraft / airports (no notifications). */
export const favorites = pgTable(
  'favorites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: favoriteKind('kind').notNull(),
    ref: jsonb('ref').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_favorites_user_kind').on(t.userId, t.kind)],
);

/** Notification channels — per-user delivery endpoints + verification state. */
export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channel: channel('channel').notNull(),
    address: jsonb('address').notNull(),
    verified: boolean('verified').notNull().default(false),
    linkToken: text('link_token'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_channels_user').on(t.userId, t.channel),
    index('idx_channels_link_token').on(t.linkToken).where(sql`${t.linkToken} is not null`),
  ],
);
