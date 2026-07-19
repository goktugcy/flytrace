import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth.ts';

/**
 * Per-user MFA (TOTP) enrolment state (docs/15 §7a). One row per user; the row
 * exists once enrolment begins (secret stored, `enabled=false`) and flips to
 * `enabled=true` on the first successful token confirmation.
 */
export const userMfa = pgTable('user_mfa', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  // Base32-encoded shared secret (RFC 4648). Stored server-side; never returned
  // after enrolment confirmation.
  secret: text('secret').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One-time recovery codes. Codes are stored hashed (KDF); `used_at` is stamped
 * when a code is consumed so it can never be replayed.
 */
export const mfaBackupCodes = pgTable(
  'mfa_backup_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_mfa_backup_codes_user').on(t.userId)],
);
