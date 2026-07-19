/**
 * Security audit trail behind a port. The DEFAULT adapter keeps entries in
 * memory (zero services, ideal for tests/local); a DB-backed adapter delegates
 * to an injected repo whose real drizzle implementation lives in packages/db
 * (see manifest). Records survive user deletion — audit entries are never FK'd
 * to users — so `actorId` is a nullable free-standing id.
 */
import { type AdapterFactory, type Clock, selectAdapter, systemClock } from '@flytrace/shared';

export interface AuditEntryInput {
  actorId?: string | undefined;
  action: string;
  target?: string | undefined;
  ip?: string | undefined;
  meta?: Record<string, unknown> | undefined;
}

export interface AuditEntry {
  id: string;
  actorId: string | null;
  action: string;
  target: string | null;
  ip: string | null;
  meta: Record<string, unknown> | null;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
}

export interface AuditListFilter {
  actorId?: string | undefined;
  action?: string | undefined;
  /** Max rows, newest first (default 100). */
  limit?: number | undefined;
}

export interface AuditLog {
  record(entry: AuditEntryInput): Promise<void>;
  list(filter: AuditListFilter): Promise<AuditEntry[]>;
}

/** Build a fully-populated entry from caller input + clock/id generator. */
function toEntry(input: AuditEntryInput, id: string, createdAt: string): AuditEntry {
  return {
    id,
    actorId: input.actorId ?? null,
    action: input.action,
    target: input.target ?? null,
    ip: input.ip ?? null,
    meta: input.meta ?? null,
    createdAt,
  };
}

/**
 * In-memory audit log for tests/local. Retains insertion order and returns
 * newest-first on `list`, applying optional actor/action filters and a limit.
 */
export class InMemoryAuditLog implements AuditLog {
  private readonly entries: AuditEntry[] = [];

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly genId: () => string = () => crypto.randomUUID(),
  ) {}

  async record(entry: AuditEntryInput): Promise<void> {
    this.entries.push(toEntry(entry, this.genId(), this.clock.nowIso()));
  }

  async list(filter: AuditListFilter): Promise<AuditEntry[]> {
    let rows = this.entries;
    if (filter.actorId) rows = rows.filter((e) => e.actorId === filter.actorId);
    if (filter.action) rows = rows.filter((e) => e.action === filter.action);
    const limit = filter.limit ?? 100;
    return [...rows].reverse().slice(0, limit);
  }

  /** Test helper: total retained rows. */
  size(): number {
    return this.entries.length;
  }
}

/**
 * Persistence port the DB adapter delegates to. The concrete drizzle repo
 * (packages/db/src/repos/security-audit.ts, described in the manifest)
 * implements this against the `audit_log` table.
 */
export interface AuditLogRepo {
  insert(entry: AuditEntry): Promise<void>;
  query(filter: AuditListFilter): Promise<AuditEntry[]>;
}

/**
 * DB-backed audit log. Builds the entry (id + timestamp) here so the repo stays
 * a thin insert/query layer and remains trivially fakeable in tests.
 */
export class DbAuditLog implements AuditLog {
  constructor(
    private readonly repo: AuditLogRepo,
    private readonly clock: Clock = systemClock,
    private readonly genId: () => string = () => crypto.randomUUID(),
  ) {}

  async record(entry: AuditEntryInput): Promise<void> {
    await this.repo.insert(toEntry(entry, this.genId(), this.clock.nowIso()));
  }

  async list(filter: AuditListFilter): Promise<AuditEntry[]> {
    return this.repo.query(filter);
  }
}

export interface AuditLogConfig {
  AUDIT_BACKEND?: string | undefined;
}

export interface AuditLogFactoryDeps {
  repo?: AuditLogRepo | undefined;
  clock?: Clock | undefined;
  genId?: (() => string) | undefined;
  logger?:
    | {
        warn: (msg: string, meta?: unknown) => void;
        info?: (msg: string, meta?: unknown) => void;
      }
    | undefined;
}

/**
 * Build the configured audit log. `AUDIT_BACKEND=db` selects the DB adapter
 * when a repo is supplied; otherwise (or `memory`) uses the in-memory default.
 */
export function createAuditLog(
  cfg: AuditLogConfig,
  deps: AuditLogFactoryDeps = {},
): Promise<AuditLog> {
  const clock = deps.clock ?? systemClock;
  const genId = deps.genId ?? (() => crypto.randomUUID());
  const adapters: Record<string, AdapterFactory<AuditLog>> = {
    memory: () => new InMemoryAuditLog(clock, genId),
    db: () =>
      deps.repo ? new DbAuditLog(deps.repo, clock, genId) : new InMemoryAuditLog(clock, genId),
  };
  return selectAdapter({
    label: 'audit-log',
    kind: cfg.AUDIT_BACKEND,
    adapters,
    fallback: 'memory',
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
