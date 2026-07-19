/**
 * Pure, unit-testable resolution of PgBouncer-aware pool options from the
 * environment. Kept side-effect free so it can be exercised without a real
 * database or process env — see connection-manager.ts for how these options
 * are applied to postgres-js/drizzle.
 *
 * Reads:
 *  - DB_POOL_MODE / PG_POOL_MODE  'session' | 'transaction'  (default: 'session')
 *  - DB_POOL_MAX / PG_POOL_MAX    integer > 0                 (default: 10)
 *  - PG_PREPARE                  boolean                      (default: true in session mode;
 *                  ALWAYS forced false in transaction mode — see below)
 *  - DB_POOL_IDLE_TIMEOUT_MS, DB_POOL_CONNECTION_TIMEOUT_MS, DB_POOL_MAX_LIFETIME_MS
 *  - DB_STATEMENT_TIMEOUT_MS
 */

export type PoolMode = 'session' | 'transaction';

/** Subset of the environment this module cares about. */
export interface PoolEnv {
  DB_POOL_MODE?: string | undefined;
  DB_POOL_MAX?: string | number | undefined;
  DB_POOL_IDLE_TIMEOUT_MS?: string | number | undefined;
  DB_POOL_CONNECTION_TIMEOUT_MS?: string | number | undefined;
  DB_POOL_MAX_LIFETIME_MS?: string | number | undefined;
  DB_STATEMENT_TIMEOUT_MS?: string | number | undefined;
  PG_POOL_MODE?: string | undefined;
  PG_POOL_MAX?: string | number | undefined;
  PG_PREPARE?: string | boolean | undefined;
}

/** Resolved, normalized pool options ready to feed into createPooledDb. */
export interface ResolvedPoolConfig {
  poolMode: PoolMode;
  max: number;
  idleTimeoutSec: number;
  connectTimeoutSec: number;
  maxLifetimeSec: number;
  statementTimeoutMs: number;
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
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_LIFETIME_MS = 30 * 60 * 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;

function parsePositiveInt(value: string | number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;
  const n = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
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
  const poolMode = resolvePoolMode(env.DB_POOL_MODE ?? env.PG_POOL_MODE);
  const max = parsePositiveInt(env.DB_POOL_MAX ?? env.PG_POOL_MAX, DEFAULT_MAX);
  const idleTimeoutMs = parsePositiveInt(env.DB_POOL_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS);
  const connectionTimeoutMs = parsePositiveInt(
    env.DB_POOL_CONNECTION_TIMEOUT_MS,
    DEFAULT_CONNECTION_TIMEOUT_MS,
  );
  const maxLifetimeMs = parsePositiveInt(env.DB_POOL_MAX_LIFETIME_MS, DEFAULT_MAX_LIFETIME_MS);
  const statementTimeoutMs = parsePositiveInt(
    env.DB_STATEMENT_TIMEOUT_MS,
    DEFAULT_STATEMENT_TIMEOUT_MS,
  );

  // Transaction pooling ALWAYS disables prepared statements; session pooling
  // honours PG_PREPARE and defaults to enabled.
  const prepare = poolMode === 'transaction' ? false : parseBool(env.PG_PREPARE, true);

  return {
    poolMode,
    max,
    idleTimeoutSec: Math.ceil(idleTimeoutMs / 1000),
    connectTimeoutSec: Math.ceil(connectionTimeoutMs / 1000),
    maxLifetimeSec: Math.ceil(maxLifetimeMs / 1000),
    statementTimeoutMs,
    prepare,
  };
}
