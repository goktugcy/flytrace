import { describe, expect, it } from 'bun:test';
import { fixedClock } from '@flytrace/shared';
import {
  type AuditEntry,
  type AuditListFilter,
  type AuditLogRepo,
  DbAuditLog,
  InMemoryAuditLog,
  createAuditLog,
} from './audit-log.ts';

function seqIds() {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

describe('InMemoryAuditLog', () => {
  it('records entries with defaults filled and a clock timestamp', async () => {
    const log = new InMemoryAuditLog(fixedClock(1_700_000_000_000), seqIds());
    await log.record({ action: 'sign_in' });
    const [entry] = await log.list({});
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('id-1');
    expect(entry?.action).toBe('sign_in');
    expect(entry?.actorId).toBeNull();
    expect(entry?.target).toBeNull();
    expect(entry?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('lists newest-first and filters by actor and action', async () => {
    const log = new InMemoryAuditLog(fixedClock(0), seqIds());
    await log.record({ action: 'a', actorId: 'u1' });
    await log.record({ action: 'b', actorId: 'u2' });
    await log.record({ action: 'a', actorId: 'u1' });

    const newest = await log.list({});
    expect(newest.map((e) => e.id)).toEqual(['id-3', 'id-2', 'id-1']);

    const byActor = await log.list({ actorId: 'u1' });
    expect(byActor).toHaveLength(2);

    const byAction = await log.list({ action: 'b' });
    expect(byAction).toHaveLength(1);
    expect(byAction[0]?.actorId).toBe('u2');
  });

  it('honours the limit', async () => {
    const log = new InMemoryAuditLog(fixedClock(0), seqIds());
    await log.record({ action: 'x' });
    await log.record({ action: 'x' });
    await log.record({ action: 'x' });
    expect(await log.list({ limit: 2 })).toHaveLength(2);
  });
});

describe('DbAuditLog', () => {
  function fakeRepo(): AuditLogRepo & { rows: AuditEntry[] } {
    const rows: AuditEntry[] = [];
    return {
      rows,
      async insert(entry) {
        rows.push(entry);
      },
      async query(filter: AuditListFilter) {
        return rows.filter((r) => !filter.action || r.action === filter.action);
      },
    };
  }

  it('builds a full entry and delegates to the repo', async () => {
    const repo = fakeRepo();
    const log = new DbAuditLog(repo, fixedClock(42), seqIds());
    await log.record({ action: 'role_change', actorId: 'admin1', target: 'u9', ip: '10.0.0.1' });
    expect(repo.rows).toHaveLength(1);
    const row = repo.rows[0];
    expect(row?.id).toBe('id-1');
    expect(row?.target).toBe('u9');
    expect(row?.ip).toBe('10.0.0.1');
    expect(row?.createdAt).toBe(new Date(42).toISOString());
    expect(await log.list({ action: 'role_change' })).toHaveLength(1);
  });
});

describe('createAuditLog', () => {
  it('defaults to in-memory', async () => {
    const log = await createAuditLog({});
    expect(log).toBeInstanceOf(InMemoryAuditLog);
  });

  it('uses the DB adapter when configured with a repo', async () => {
    const repo: AuditLogRepo = {
      async insert() {},
      async query() {
        return [];
      },
    };
    const log = await createAuditLog({ AUDIT_BACKEND: 'db' }, { repo });
    expect(log).toBeInstanceOf(DbAuditLog);
  });

  it('degrades to in-memory when db chosen but no repo supplied', async () => {
    const log = await createAuditLog({ AUDIT_BACKEND: 'db' });
    expect(log).toBeInstanceOf(InMemoryAuditLog);
  });
});
