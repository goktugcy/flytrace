import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { providerHealth } from './_enums.ts';

/** Providers — registry + health/config for each airline provider (admin board). */
export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  config: jsonb('config'),
  health: providerHealth('health').notNull().default('down'),
  circuitState: text('circuit_state').notNull().default('closed'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastError: text('last_error'),
  p50Ms: integer('p50_ms'),
  p95Ms: integer('p95_ms'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Provider cache — durable cold cache of normalized responses (survives Redis). */
export const providerCache = pgTable(
  'provider_cache',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerKey: text('provider_key').notNull(),
    cacheKey: text('cache_key').notNull(),
    payload: jsonb('payload').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('uq_provider_cache_key').on(t.providerKey, t.cacheKey),
    index('idx_provider_cache_expires').on(t.expiresAt),
  ],
);

/** Provider logs — every provider fetch (debug, health scoring, ToS audit). */
export const providerLogs = pgTable(
  'provider_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerKey: text('provider_key').notNull(),
    operation: text('operation').notNull(),
    request: jsonb('request'),
    statusCode: integer('status_code'),
    latencyMs: integer('latency_ms'),
    success: boolean('success').notNull(),
    error: text('error'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_provider_logs_key_time').on(t.providerKey, t.createdAt),
    index('idx_provider_logs_success').on(t.success, t.createdAt),
    index('idx_provider_logs_correlation').on(t.correlationId),
  ],
);

/** Audit logs — who did what (admin actions, auth events). Append-only. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id'),
    actorType: text('actor_type').notNull().default('user'),
    action: text('action').notNull(),
    entity: text('entity'),
    entityId: text('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    correlationId: text('correlation_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_audit_actor_time').on(t.actorUserId, t.createdAt),
    index('idx_audit_entity').on(t.entity, t.entityId),
  ],
);

/** Settings — runtime feature flags / operational config editable by admins. */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  description: text('description'),
  updatedBy: uuid('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Outbox — transactional outbox for reliable event publishing. */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    aggregate: text('aggregate').notNull(),
    aggregateId: uuid('aggregate_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    published: boolean('published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('idx_outbox_unpublished').on(t.createdAt).where(sql`${t.published} = false`)],
);
