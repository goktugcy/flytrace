import { describe, expect, test } from 'bun:test';
import { type BackupFs, type CommandResult, PgDumpBackupManager } from './pgdump.ts';

function fixedClock(start = 1_700_000_000_000, step = 10) {
  let t = start;
  return () => {
    const now = t;
    t += step;
    return now;
  };
}

/** Fake runner that records argv and returns scripted results per binary. */
function fakeRunner(script: (cmd: string, args: string[]) => CommandResult) {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    run: async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      return script(cmd, args);
    },
  };
}

function fakeFs(over: Partial<BackupFs> = {}): BackupFs {
  return {
    mkdir: async () => {},
    readdir: async () => [],
    stat: async () => ({ sizeBytes: 4096, createdAtMs: 1_700_000_000_000 }),
    exists: async () => true,
    ...over,
  };
}

const OK: CommandResult = { code: 0, stdout: '', stderr: '' };

describe('PgDumpBackupManager.backup', () => {
  test('invokes pg_dump with custom-format argv and returns a ref', async () => {
    const runner = fakeRunner(() => OK);
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://u:p@host/db', backupDir: '/var/backups' },
      { runner, fs: fakeFs(), now: fixedClock() },
    );

    const res = await mgr.backup();

    expect(runner.calls).toHaveLength(1);
    const { cmd, args } = runner.calls[0] as { cmd: string; args: string[] };
    expect(cmd).toBe('pg_dump');
    expect(args).toContain('--format=custom');
    expect(args).toContain('--no-owner');
    expect(args).toContain('--dbname=postgres://u:p@host/db');
    expect(args).toContain('--file=/var/backups/dump-1700000000000.dump');

    expect(res.ref).toEqual({
      id: 'dump-1700000000000',
      createdAt: '2023-11-14T22:13:20.000Z',
      sizeBytes: 4096,
      kind: 'dump',
    });
    expect(res.durationMs).toBe(10);
    expect(res.location).toBe('/var/backups/dump-1700000000000.dump');
  });

  test('throws with stderr (never the URL) on pg_dump failure', async () => {
    const runner = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'permission denied' }));
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://secret@host/db', backupDir: '/b' },
      { runner, fs: fakeFs() },
    );
    const err = await mgr.backup().then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/pg_dump failed \(exit 1\): permission denied/);
    expect(err?.message).not.toContain('secret');
  });

  test('honors overridden pg_dump binary', async () => {
    const runner = fakeRunner(() => OK);
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b', pgDumpBin: '/opt/pg16/pg_dump' },
      { runner, fs: fakeFs(), now: fixedClock() },
    );
    await mgr.backup();
    expect(runner.calls[0]?.cmd).toBe('/opt/pg16/pg_dump');
  });
});

describe('PgDumpBackupManager.restore', () => {
  test('invokes pg_restore --clean --if-exists with the archive path', async () => {
    const runner = fakeRunner(() => OK);
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner, fs: fakeFs({ exists: async () => true }) },
    );
    await mgr.restore('dump-42');
    const { cmd, args } = runner.calls[0] as { cmd: string; args: string[] };
    expect(cmd).toBe('pg_restore');
    expect(args).toContain('--clean');
    expect(args).toContain('--if-exists');
    expect(args).toContain('--dbname=postgres://x/y');
    expect(args[args.length - 1]).toBe('/b/dump-42.dump');
  });

  test('throws when the backup file is missing (no runner call)', async () => {
    const runner = fakeRunner(() => OK);
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner, fs: fakeFs({ exists: async () => false }) },
    );
    await expect(mgr.restore('gone')).rejects.toThrow(/not found/);
    expect(runner.calls).toHaveLength(0);
  });

  test('throws on non-zero pg_restore exit', async () => {
    const runner = fakeRunner(() => ({ code: 2, stdout: '', stderr: 'boom' }));
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner, fs: fakeFs() },
    );
    await expect(mgr.restore('dump-1')).rejects.toThrow(/pg_restore failed \(exit 2\): boom/);
  });
});

describe('PgDumpBackupManager.verify', () => {
  test('ok when pg_restore --list succeeds with a TOC', async () => {
    const runner = fakeRunner((_c, args) =>
      args[0] === '--list' ? { code: 0, stdout: ';\n; Archive created\n', stderr: '' } : OK,
    );
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner, fs: fakeFs() },
    );
    expect(await mgr.verify('dump-1')).toEqual({ ok: true });
    expect(runner.calls[0]?.args).toEqual(['--list', '/b/dump-1.dump']);
  });

  test('not ok on empty TOC or non-zero exit or missing file', async () => {
    const emptyRunner = fakeRunner(() => ({ code: 0, stdout: '   ', stderr: '' }));
    const empty = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner: emptyRunner, fs: fakeFs() },
    );
    expect((await empty.verify('dump-1')).ok).toBe(false);

    const failRunner = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'corrupt' }));
    const fail = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner: failRunner, fs: fakeFs() },
    );
    expect((await fail.verify('dump-1')).detail).toMatch(/corrupt/);

    const missing = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b' },
      { runner: fakeRunner(() => OK), fs: fakeFs({ exists: async () => false }) },
    );
    expect(await missing.verify('gone')).toEqual({ ok: false, detail: 'backup "gone" not found' });
  });
});

describe('PgDumpBackupManager.list', () => {
  test('lists dump archives and WAL segments, newest first', async () => {
    const times: Record<string, number> = {
      'dump-1000.dump': 1000,
      'dump-3000.dump': 3000,
      '000000010000000000000001': 2000,
    };
    const fs = fakeFs({
      readdir: async (dir: string) =>
        dir === '/wal'
          ? ['000000010000000000000001']
          : ['dump-1000.dump', 'dump-3000.dump', 'notes.txt'],
      stat: async (path: string) => {
        const name = path.split('/').pop() as string;
        return { sizeBytes: 10, createdAtMs: times[name] ?? 0 };
      },
    });
    const mgr = new PgDumpBackupManager(
      { databaseUrl: 'postgres://x/y', backupDir: '/b', walArchiveDir: '/wal' },
      { runner: fakeRunner(() => OK), fs },
    );

    const refs = await mgr.list();
    // notes.txt filtered out; sorted newest first by createdAt.
    expect(refs.map((r) => r.id)).toEqual(['dump-3000', '000000010000000000000001', 'dump-1000']);
    expect(refs.find((r) => r.kind === 'wal')?.id).toBe('000000010000000000000001');
  });
});
