import { boolean, index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { citext } from './_custom.ts';
import { userRole } from './_enums.ts';

/** Users — identity + ownership of personalization. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  name: text('name'),
  image: text('image'),
  role: userRole('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Accounts — Better Auth provider links (OAuth / credentials). */
export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    passwordHash: text('password_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_accounts_user').on(t.userId),
    index('uq_accounts_provider').on(t.provider, t.providerAccountId),
  ],
);

/**
 * Sessions — server-managed sessions.
 *
 * The cookie carries a 256-bit opaque token; only its SHA-256 digest is stored
 * (`token_hash`, 64 hex chars — see `@flytrace/shared` `hashToken`). A database
 * dump therefore yields no usable bearer credential. Lookups hash the presented
 * token and hit the unique index.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Device this session was minted for (links a session to its refresh family). */
    deviceId: uuid('device_id'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_sessions_user').on(t.userId),
    index('idx_sessions_expires').on(t.expiresAt),
    index('idx_sessions_device').on(t.deviceId),
  ],
);

/** User settings — preferences (theme, locale, units, quiet hours). */
export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  theme: text('theme').notNull().default('dark'),
  locale: text('locale').notNull().default('en'),
  distanceUnit: text('distance_unit').notNull().default('km'),
  timeFormat: text('time_format').notNull().default('24h'),
  quietHours: jsonb('quiet_hours'),
  defaultChannels: jsonb('default_channels'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
