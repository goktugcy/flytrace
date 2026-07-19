import { index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Security audit trail (docs §7c). Append-only record of security-relevant
 * actions (sign-in, role change, admin ops, rate-limit trips, …).
 *
 * `actor_id` is a nullable free-standing uuid rather than a FK to `users`: some
 * events have no authenticated actor, and audit rows must survive user
 * deletion, so we deliberately avoid an ON DELETE CASCADE reference. Queries
 * are served by the composite (actor_id, created_at) index for per-actor,
 * time-ordered listing.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    target: text('target'),
    ip: inet('ip'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_audit_log_actor_created').on(t.actorId, t.createdAt)],
);
