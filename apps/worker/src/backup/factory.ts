/**
 * createBackupManager — composition-time selection of the DR adapter, keyed on
 * `BACKUP_PROVIDER` via the shared `selectAdapter` convention. The in-memory
 * `mock` is always the fallback, so the worker boots with zero external
 * services. `pgdump` is only registered when its required config
 * (DATABASE_URL + BACKUP_DIR) is present; otherwise selection degrades to the
 * mock with a warning rather than failing at boot.
 */
import { type AdapterFactory, selectAdapter } from '@flytrace/shared';
import { MockBackupManager } from './adapters/mock.ts';
import {
  type BackupFs,
  type CommandRunner,
  PgDumpBackupManager,
  createBackupFs,
  createCommandRunner,
} from './adapters/pgdump.ts';
import type { BackupManager } from './backup-manager.ts';

export interface BackupManagerConfig {
  /** 'mock' (default) | 'pgdump'. */
  BACKUP_PROVIDER?: string;
  DATABASE_URL?: string;
  /** Directory for pg_dump archives (required for the pgdump adapter). */
  BACKUP_DIR?: string;
  /** Optional archived-WAL directory for point-in-time-recovery listing. */
  WAL_ARCHIVE_DIR?: string;
  PG_DUMP_BIN?: string;
  PG_RESTORE_BIN?: string;
}

export interface BackupManagerDeps {
  /** Injected process runner (default wraps Bun.spawn). */
  runner?: CommandRunner;
  fs?: BackupFs;
  now?: () => number;
  logger?: {
    info?: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error?: (m: string, meta?: unknown) => void;
  };
}

export function createBackupManager(
  cfg: BackupManagerConfig,
  deps: BackupManagerDeps = {},
): Promise<BackupManager> {
  const adapters: Record<string, AdapterFactory<BackupManager>> = {
    mock: () =>
      new MockBackupManager({
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      }),
  };

  // Only offer pgdump when it can actually run; else selectAdapter falls back.
  if (cfg.DATABASE_URL && cfg.BACKUP_DIR) {
    adapters.pgdump = () =>
      new PgDumpBackupManager(
        {
          databaseUrl: cfg.DATABASE_URL as string,
          backupDir: cfg.BACKUP_DIR as string,
          ...(cfg.WAL_ARCHIVE_DIR ? { walArchiveDir: cfg.WAL_ARCHIVE_DIR } : {}),
          ...(cfg.PG_DUMP_BIN ? { pgDumpBin: cfg.PG_DUMP_BIN } : {}),
          ...(cfg.PG_RESTORE_BIN ? { pgRestoreBin: cfg.PG_RESTORE_BIN } : {}),
        },
        {
          runner: deps.runner ?? createCommandRunner(),
          fs: deps.fs ?? createBackupFs(),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.logger ? { logger: deps.logger } : {}),
        },
      );
  }

  return selectAdapter({
    label: 'backup',
    kind: cfg.BACKUP_PROVIDER,
    adapters,
    fallback: 'mock',
    ...(deps.logger ? { logger: deps.logger } : {}),
  });
}
