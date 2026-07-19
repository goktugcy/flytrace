/**
 * PgDumpBackupManager — the real, env-gated adapter. It shells out to
 * `pg_dump` / `pg_restore` through an INJECTED command runner (so tests assert
 * the exact argv without spawning processes) and stores custom-format archives
 * under `BACKUP_DIR`. It also enumerates archived WAL segments from
 * `WAL_ARCHIVE_DIR` for point-in-time-recovery visibility.
 *
 * Requires `DATABASE_URL` + `BACKUP_DIR`; the factory only selects this adapter
 * when both are present, otherwise it degrades to the in-memory mock.
 *
 * Security: the DATABASE_URL is passed as an argv `--dbname` value and is never
 * written into logs or error messages.
 */
import { promises as nodeFs } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type {
  BackupManager,
  BackupRef,
  BackupRefLike,
  BackupResult,
  VerifyResult,
} from '../backup-manager.ts';
import { backupRefId } from '../backup-manager.ts';

/** Result of running an external command. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injected process runner — the seam that makes this adapter testable. */
export interface CommandRunner {
  run(cmd: string, args: string[]): Promise<CommandResult>;
}

/** Minimal filesystem surface the adapter needs (injectable for tests). */
export interface BackupFs {
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ sizeBytes: number; createdAtMs: number }>;
  exists(path: string): Promise<boolean>;
}

export interface PgDumpConfig {
  /** Postgres connection string (never logged). */
  databaseUrl: string;
  /** Directory holding `*.dump` custom-format archives. */
  backupDir: string;
  /** Optional directory holding archived WAL segments. */
  walArchiveDir?: string;
  /** Override the pg_dump binary name/path (default 'pg_dump'). */
  pgDumpBin?: string;
  /** Override the pg_restore binary name/path (default 'pg_restore'). */
  pgRestoreBin?: string;
}

export interface PgDumpDeps {
  runner: CommandRunner;
  fs?: BackupFs;
  now?: () => number;
  logger?: {
    info?: (m: string, meta?: unknown) => void;
    warn?: (m: string, meta?: unknown) => void;
    error?: (m: string, meta?: unknown) => void;
  };
}

const DUMP_EXT = '.dump';

/** Default {@link CommandRunner} backed by Bun.spawn. */
export function createCommandRunner(): CommandRunner {
  return {
    async run(cmd, args) {
      const proc = Bun.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      return { code, stdout, stderr };
    },
  };
}

/** Default {@link BackupFs} backed by node:fs/promises. */
export function createBackupFs(): BackupFs {
  return {
    async mkdir(dir) {
      await nodeFs.mkdir(dir, { recursive: true });
    },
    async readdir(dir) {
      try {
        return await nodeFs.readdir(dir);
      } catch {
        return [];
      }
    },
    async stat(path) {
      const s = await nodeFs.stat(path);
      return { sizeBytes: s.size, createdAtMs: s.birthtimeMs || s.mtimeMs };
    },
    async exists(path) {
      try {
        await nodeFs.stat(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export class PgDumpBackupManager implements BackupManager {
  private readonly fs: BackupFs;
  private readonly now: () => number;
  private readonly runner: CommandRunner;
  private readonly logger: PgDumpDeps['logger'];
  private readonly pgDumpBin: string;
  private readonly pgRestoreBin: string;

  constructor(
    private readonly cfg: PgDumpConfig,
    deps: PgDumpDeps,
  ) {
    this.runner = deps.runner;
    this.fs = deps.fs ?? createBackupFs();
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
    this.pgDumpBin = cfg.pgDumpBin ?? 'pg_dump';
    this.pgRestoreBin = cfg.pgRestoreBin ?? 'pg_restore';
  }

  /** Absolute path of the archive for a dump id. */
  private dumpPath(id: string): string {
    return join(this.cfg.backupDir, `${id}${DUMP_EXT}`);
  }

  async backup(): Promise<BackupResult> {
    await this.fs.mkdir(this.cfg.backupDir);
    const startedMs = this.now();
    const id = `dump-${startedMs}`;
    const file = this.dumpPath(id);
    // Custom format (-Fc) → compressible + selectively restorable via pg_restore.
    const args = [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${file}`,
      `--dbname=${this.cfg.databaseUrl}`,
    ];
    const res = await this.runner.run(this.pgDumpBin, args);
    if (res.code !== 0) {
      throw new Error(`pg_dump failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
    const { sizeBytes } = await this.fs.stat(file);
    const durationMs = Math.max(0, this.now() - startedMs);
    const ref: BackupRef = {
      id,
      createdAt: new Date(startedMs).toISOString(),
      sizeBytes,
      kind: 'dump',
    };
    this.logger?.info?.('pg_dump backup complete', { id, sizeBytes, durationMs });
    return { ref, durationMs, location: file };
  }

  async restore(ref: BackupRefLike): Promise<void> {
    const id = backupRefId(ref);
    const file = this.dumpPath(id);
    if (!(await this.fs.exists(file))) {
      throw new Error(`pg_restore: backup "${id}" not found`);
    }
    // --clean --if-exists drops objects first so restore is repeatable.
    const args = [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      `--dbname=${this.cfg.databaseUrl}`,
      file,
    ];
    const res = await this.runner.run(this.pgRestoreBin, args);
    if (res.code !== 0) {
      throw new Error(`pg_restore failed (exit ${res.code}): ${res.stderr.trim()}`);
    }
    this.logger?.info?.('pg_restore complete', { id });
  }

  async verify(ref: BackupRefLike): Promise<VerifyResult> {
    const id = backupRefId(ref);
    const file = this.dumpPath(id);
    if (!(await this.fs.exists(file))) {
      return { ok: false, detail: `backup "${id}" not found` };
    }
    // `pg_restore --list` parses the archive TOC without touching the DB; a
    // non-zero exit or empty TOC signals a corrupt/truncated archive.
    const res = await this.runner.run(this.pgRestoreBin, ['--list', file]);
    if (res.code !== 0) {
      return { ok: false, detail: `pg_restore --list exit ${res.code}: ${res.stderr.trim()}` };
    }
    if (res.stdout.trim().length === 0) {
      return { ok: false, detail: 'empty archive table-of-contents' };
    }
    return { ok: true };
  }

  async list(): Promise<BackupRef[]> {
    const refs: BackupRef[] = [];

    for (const name of await this.fs.readdir(this.cfg.backupDir)) {
      if (extname(name) !== DUMP_EXT) continue;
      const id = basename(name, DUMP_EXT);
      const path = join(this.cfg.backupDir, name);
      try {
        const { sizeBytes, createdAtMs } = await this.fs.stat(path);
        refs.push({ id, createdAt: new Date(createdAtMs).toISOString(), sizeBytes, kind: 'dump' });
      } catch (err) {
        this.logger?.warn?.('skipping unreadable backup', { name, err: String(err) });
      }
    }

    if (this.cfg.walArchiveDir) {
      for (const name of await this.fs.readdir(this.cfg.walArchiveDir)) {
        const path = join(this.cfg.walArchiveDir, name);
        try {
          const { sizeBytes, createdAtMs } = await this.fs.stat(path);
          refs.push({
            id: name,
            createdAt: new Date(createdAtMs).toISOString(),
            sizeBytes,
            kind: 'wal',
          });
        } catch (err) {
          this.logger?.warn?.('skipping unreadable WAL segment', { name, err: String(err) });
        }
      }
    }

    // Newest first.
    return refs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
}
