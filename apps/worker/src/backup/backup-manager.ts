/**
 * Disaster Recovery — the BackupManager abstraction (Module 9). Business/ops
 * code depends only on this interface; a concrete adapter (pg_dump-based, or the
 * in-memory mock) is chosen from config at composition time via `selectAdapter`.
 *
 * The contract is deliberately storage-agnostic: a "backup" is either a logical
 * `dump` (pg_dump custom-format archive) or an archived `wal` segment, each
 * addressed by an opaque `BackupRef`. Every operation is async and side-effect
 * free from the caller's perspective — the adapter owns where bytes live.
 */

/** A backup is either a logical dump archive or an archived WAL segment. */
export type BackupKind = 'dump' | 'wal';

/** Opaque, listable handle to one stored backup artifact. */
export interface BackupRef {
  /** Adapter-stable identifier (also the on-disk basename for pg_dump). */
  id: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** Artifact size on disk, in bytes. */
  sizeBytes: number;
  kind: BackupKind;
}

/** Outcome of a successful `backup()`. */
export interface BackupResult {
  ref: BackupRef;
  /** Wall-clock time the backup took, in milliseconds. */
  durationMs: number;
  /** Human/ops-facing location hint (path or logical URI). */
  location: string;
}

/** Result of an integrity `verify()`. */
export interface VerifyResult {
  ok: boolean;
  detail?: string;
}

/** Either a full ref or just its id — both address the same artifact. */
export type BackupRefLike = BackupRef | string;

/** Resolve a {@link BackupRefLike} to its stable id. */
export function backupRefId(ref: BackupRefLike): string {
  return typeof ref === 'string' ? ref : ref.id;
}

/**
 * Disaster-recovery surface: take a backup, restore from one, verify one's
 * integrity, and enumerate what exists. Adapters must be idempotent-safe and
 * never leak credentials (e.g. DATABASE_URL) into logs or errors.
 */
export interface BackupManager {
  /** Take a new backup and return its ref + timing. */
  backup(): Promise<BackupResult>;
  /** Restore the database from a previously-taken backup. */
  restore(ref: BackupRefLike): Promise<void>;
  /** Check a backup's integrity without mutating the database. */
  verify(ref: BackupRefLike): Promise<VerifyResult>;
  /** List all known backups, newest first. */
  list(): Promise<BackupRef[]>;
}
