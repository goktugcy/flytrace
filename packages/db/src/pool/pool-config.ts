/**
 * Pure, unit-testable resolution of PgBouncer-aware pool options from the
 * environment. Kept side-effect free so it can be exercised without a real
 * database or process env — see connection-manager.ts for how these options
 * are applied to postgres-js/drizzle.
 *
 * Reads:
 *  - PG_POOL_MODE  'session' | 'transaction'  (default: 'session')
 *  - PG_POOL_MAX   integer > 0                 (default: 10)
 *  - PG_PREPARE    boolean                     (default: true in session mode;
 *                  ALWAYS forced false in transaction mode — see below)
 */

export type PoolMode = 'session' | 'transaction';

/** Subset of the environment this module cares about. */
export interface PoolEnv {
  PG_POOL_MODE?: string | undefined;
  PG_POOL_MAX?: string | undefined;
  PG_PREPARE?: string | undefined;
}

/** Resolved, normalized pool options ready to feed into createPooledDb. */
export interface ResolvedPoolConfig {
  poolMode: PoolMode;
  max: number;
  /**
   * Whether postgres-js should use named prepared statements.
   *
   * CRITICAL: under PgBouncer transaction pooling a client connection is only
   * pinned to a backend server connection for the lifetime of a single
   * transaction. Named prepared statements live on the *server* connection and
   * therefore cannot be relied upon across statements/transactions once the
   * backend rotates — this is the classic
   * "prepared statement \"s0\" does not exist" failure. We force `prepare`
   * to `false` in transaction mode regardless of PG_PREPARE.
   */
  prepare: boolean;
}

const DEFAULT_MAX = 10;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

export function resolvePoolMode(value: string | undefined): PoolMode {
  return value?.trim().toLowerCase() === 'transaction' ? 'transaction' : 'session';
}

export function resolvePoolConfig(env: PoolEnv): ResolvedPoolConfig {
  const poolMode = resolvePoolMode(env.PG_POOL_MODE);
  const max = parsePositiveInt(env.PG_POOL_MAX, DEFAULT_MAX);

  // Transaction pooling ALWAYS disables prepared statements; session pooling
  // honours PG_PREPARE and defaults to enabled.
  const prepare = poolMode === 'transaction' ? false : parseBool(env.PG_PREPARE, true);

  return { poolMode, max, prepare };
}
