import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { channel, notifStatus } from './_enums.ts';
import { users } from './auth.ts';
import { flightEvents, flights } from './flights.ts';
import { watchlistItems } from './personalization.ts';

/** Notifications — record of every alert (history, dedupe, audit, dashboard feed). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    watchlistItemId: uuid('watchlist_item_id').references(() => watchlistItems.id, {
      onDelete: 'set null',
    }),
    flightEventId: uuid('flight_event_id').references(() => flightEvents.id, {
      onDelete: 'set null',
    }),
    flightId: uuid('flight_id').references(() => flights.id, { onDelete: 'set null' }),
    channel: channel('channel').notNull(),
    status: notifStatus('status').notNull().default('queued'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    payload: jsonb('payload'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_notifications_user_created').on(t.userId, t.createdAt),
    index('idx_notifications_status').on(t.status),
    index('idx_notifications_event').on(t.flightEventId),
  ],
);
