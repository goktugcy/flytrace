/**
 * In-memory MockBackupManager — the DEFAULT adapter (via factory fallback). It
 * requires no database, no filesystem, and no external tooling, so the worker
 * boots and tests run with zero setup. Behaviour is deterministic: backup ids,
 * timestamps and sizes derive from an injected clock + monotonic counter, and
 * restore/verify always succeed for a known ref.
 */
import type {
  BackupKind,
  BackupManager,
  BackupRef,
  BackupRefLike,
  BackupResult,
  VerifyResult,
} from '../backup-manager.ts';
import { backupRefId } from '../backup-manager.ts';

export interface MockBackupManagerDeps {
  /** Injected clock for deterministic timestamps/durations (default Date.now). */
  now?: () => number;
  logger?: { info?: (m: string, meta?: unknown) => void };
}

/**
 * Records backups in an array and serves them back. `backup()` advances the
 * injected clock-derived counter so each artifact is distinct and reproducible.
 */
export class MockBackupManager implements BackupManager {
  private readonly now: () => number;
  private readonly logger: MockBackupManagerDeps['logger'];
  private readonly store: BackupRef[] = [];
  private counter = 0;

  constructor(deps: MockBackupManagerDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.logger = deps.logger;
  }

  async backup(kind: BackupKind = 'dump'): Promise<BackupResult> {
    const startedMs = this.now();
    this.counter += 1;
    const n = this.counter;
    const ref: BackupRef = {
      id: `mock-${kind}-${n}`,
      createdAt: new Date(startedMs).toISOString(),
      // Deterministic, non-zero size that grows per backup.
      sizeBytes: 1024 * n,
      kind,
    };
    this.store.push(ref);
    const durationMs = Math.max(0, this.now() - startedMs);
    this.logger?.info?.('mock backup taken', { id: ref.id, kind });
    return { ref, durationMs, location: `mock://backups/${ref.id}` };
  }

  async restore(ref: BackupRefLike): Promise<void> {
    const id = backupRefId(ref);
    if (!this.store.some((r) => r.id === id)) {
      throw new Error(`mock backup: unknown ref "${id}"`);
    }
    this.logger?.info?.('mock restore', { id });
  }

  async verify(ref: BackupRefLike): Promise<VerifyResult> {
    const id = backupRefId(ref);
    const found = this.store.some((r) => r.id === id);
    return found ? { ok: true } : { ok: false, detail: `unknown ref "${id}"` };
  }

  async list(): Promise<BackupRef[]> {
    // Newest first, matching the pg_dump adapter's ordering.
    return [...this.store].reverse();
  }
}
