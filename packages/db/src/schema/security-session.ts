import {
  boolean,
  index,
  inet,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

/**
 * Session security (docs §7b) — refresh-token rotation + device management.
 *
 * Refresh tokens are OPAQUE and stored HASHED at rest (`token_hash`, a fast
 * deterministic digest so lookups by hash are possible — never argon2 here).
 * Rotation lineage is tracked via `family_id` (a rotation family) + `replaced_by`
 * (points at the token that superseded this one). Presenting an already-rotated
 * (revoked) token is treated as reuse and revokes the whole family.
 */
export const userDevices = pgTable(
  'user_devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Stable fingerprint hash of user-agent + coarse (prefix) IP. */
    fingerprint: text('fingerprint').notNull(),
    ua: text('ua'),
    lastIp: inet('last_ip'),
    trusted: boolean('trusted').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_user_devices_user').on(t.userId),
    uniqueIndex('uq_user_devices_fingerprint').on(t.userId, t.fingerprint),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => userDevices.id, { onDelete: 'cascade' }),
    /** Deterministic hash of the opaque token (never the token itself). */
    tokenHash: text('token_hash').notNull().unique(),
    /** Rotation family — shared across a token and all its rotations. */
    familyId: text('family_id').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** Id of the token that replaced this one on rotation (nullable). */
    replacedBy: uuid('replaced_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_refresh_tokens_user').on(t.userId),
    index('idx_refresh_tokens_family').on(t.familyId),
    index('idx_refresh_tokens_device').on(t.deviceId),
    index('idx_refresh_tokens_expires').on(t.expiresAt),
  ],
);
