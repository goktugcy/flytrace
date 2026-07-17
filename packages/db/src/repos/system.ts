import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import { auditLogs, providerLogs } from '../schema/system.ts';

/**
 * System-domain persistence (docs/08 §8.9, docs/15): provider traffic logging
 * for health scoring + ToS audit, and an append-only admin audit trail. Read
 * queries back the admin console's logs/audit views (docs/17 §17.4).
 */

export interface ProviderLogInput {
  providerKey: string;
  operation: string;
  request?: unknown;
  statusCode?: number | null;
  latencyMs?: number | null;
  success: boolean;
  error?: string | null;
  correlationId?: string | null;
}

export interface AuditLogInput {
  actorUserId?: string | null;
  actorType?: string;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  correlationId?: string | null;
}

export function createSystemRepo(db: Database) {
  return {
    /** Record one provider fetch (fire-and-forget from the fetch pipeline). */
    async insertProviderLog(e: ProviderLogInput): Promise<void> {
      await db.insert(providerLogs).values({
        providerKey: e.providerKey,
        operation: e.operation,
        request: e.request ?? null,
        statusCode: e.statusCode ?? null,
        latencyMs: e.latencyMs ?? null,
        success: e.success,
        error: e.error ?? null,
        correlationId: e.correlationId ?? null,
      });
    },

    async recentProviderLogs(limit: number): Promise<unknown[]> {
      return (await db.execute(sql`
        select id, provider_key as "providerKey", operation, status_code as "statusCode",
               latency_ms as "latencyMs", success, error, created_at as "createdAt"
        from provider_logs order by created_at desc limit ${limit}
      `)) as unknown as unknown[];
    },

    /** Append an admin audit entry (who did what). */
    async insertAuditLog(e: AuditLogInput): Promise<void> {
      await db.insert(auditLogs).values({
        actorUserId: e.actorUserId ?? null,
        actorType: e.actorType ?? 'user',
        action: e.action,
        entity: e.entity ?? null,
        entityId: e.entityId ?? null,
        before: e.before ?? null,
        after: e.after ?? null,
        correlationId: e.correlationId ?? null,
      });
    },

    async recentAuditLogs(limit: number): Promise<unknown[]> {
      return (await db.execute(sql`
        select id, actor_user_id as "actorUserId", actor_type as "actorType", action,
               entity, entity_id as "entityId", created_at as "createdAt"
        from audit_logs order by created_at desc limit ${limit}
      `)) as unknown as unknown[];
    },
  };
}

export type SystemRepo = ReturnType<typeof createSystemRepo>;
