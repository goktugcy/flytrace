/**
 * Module 9 — Disaster Recovery / BackupManager. Public surface for the worker
 * to compose a backup manager (mock by default, pg_dump when env-gated) and to
 * type backup refs/results.
 */
export * from './backup-manager.ts';
export * from './factory.ts';
export { MockBackupManager } from './adapters/mock.ts';
export {
  type BackupFs,
  type CommandResult,
  type CommandRunner,
  type PgDumpConfig,
  PgDumpBackupManager,
  createBackupFs,
  createCommandRunner,
} from './adapters/pgdump.ts';
