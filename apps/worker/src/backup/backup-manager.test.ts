import { describe, expect, test } from 'bun:test';
import { MockBackupManager } from './adapters/mock.ts';
import { backupRefId } from './backup-manager.ts';
import { createBackupManager } from './factory.ts';

function fixedClock(start = 1_700_000_000_000, step = 5) {
  let t = start;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

describe('backupRefId', () => {
  test('accepts a string id or a full ref', () => {
    expect(backupRefId('abc')).toBe('abc');
    expect(backupRefId({ id: 'x', createdAt: 'now', sizeBytes: 1, kind: 'dump' })).toBe('x');
  });
});

describe('MockBackupManager lifecycle', () => {
  test('backup → list → verify → restore is deterministic', async () => {
    const mgr = new MockBackupManager({ now: fixedClock() });

    const first = await mgr.backup();
    const second = await mgr.backup();

    expect(first.ref.id).toBe('mock-dump-1');
    expect(second.ref.id).toBe('mock-dump-2');
    expect(first.ref.sizeBytes).toBe(1024);
    expect(second.ref.sizeBytes).toBe(2048);
    expect(first.ref.createdAt).toBe('2023-11-14T22:13:20.000Z');
    expect(first.durationMs).toBe(5); // clock steps by 5 between now() reads
    expect(first.location).toBe('mock://backups/mock-dump-1');

    // Newest first.
    const listed = await mgr.list();
    expect(listed.map((r) => r.id)).toEqual(['mock-dump-2', 'mock-dump-1']);

    expect(await mgr.verify(first.ref)).toEqual({ ok: true });
    await expect(mgr.restore(second.ref)).resolves.toBeUndefined();
  });

  test('verify/restore reject unknown refs', async () => {
    const mgr = new MockBackupManager({ now: fixedClock() });
    expect(await mgr.verify('nope')).toEqual({ ok: false, detail: 'unknown ref "nope"' });
    await expect(mgr.restore('nope')).rejects.toThrow(/unknown ref/);
  });
});

describe('createBackupManager', () => {
  const warns: string[] = [];
  const logger = { warn: (m: string) => warns.push(m), info: () => {} };

  test('defaults to the mock adapter with no config', async () => {
    const mgr = await createBackupManager({});
    const res = await mgr.backup();
    expect(res.location.startsWith('mock://')).toBe(true);
  });

  test('falls back to mock when pgdump is requested without required env', async () => {
    warns.length = 0;
    const mgr = await createBackupManager({ BACKUP_PROVIDER: 'pgdump' }, { logger });
    // pgdump not registered (no DATABASE_URL/BACKUP_DIR) → selectAdapter warns + mock.
    expect(warns.some((w) => w.includes('unknown adapter'))).toBe(true);
    const res = await mgr.backup();
    expect(res.location.startsWith('mock://')).toBe(true);
  });

  test('selects pgdump when DATABASE_URL + BACKUP_DIR present', async () => {
    const runner = {
      calls: [] as { cmd: string; args: string[] }[],
      run: async (cmd: string, args: string[]) => {
        runner.calls.push({ cmd, args });
        return { code: 0, stdout: ';\n; Archive\n', stderr: '' };
      },
    };
    const fs = {
      mkdir: async () => {},
      readdir: async () => [],
      stat: async () => ({ sizeBytes: 42, createdAtMs: 1_700_000_000_000 }),
      exists: async () => true,
    };
    const mgr = await createBackupManager(
      { BACKUP_PROVIDER: 'pgdump', DATABASE_URL: 'postgres://x/y', BACKUP_DIR: '/tmp/bk' },
      { runner, fs, now: fixedClock() },
    );
    const res = await mgr.backup();
    expect(res.ref.kind).toBe('dump');
    expect(res.ref.sizeBytes).toBe(42);
    expect(runner.calls[0]?.cmd).toBe('pg_dump');
  });
});
