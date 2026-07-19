import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../schema/index.ts';
import type { PoolMode } from './pool-config.ts';

/**
 * PgBouncer-aware connection manager.
 *
 * Mirrors the postgres-js/drizzle setup style of ../index.ts (`createDb`) but
 * makes the pooling mode a first-class input so the same code can talk to:
 *
 *  - a direct Postgres connection, or PgBouncer in `session` pooling mode
 *    (a server connection is pinned to the client for the whole session — named
 *    prepared statements are safe), and
 *
 *  - PgBouncer in `transaction` pooling mode (a server connection is only
 *    borrowed for the lifetime of a single transaction, then returned to the
 *    pool and possibly handed to another client).
 *
 * CRITICAL — transaction pooling and prepared statements:
 * postgres-js, by default, uses *named* prepared statements. A named prepared
 * statement is created on a specific backend server connection. Under
 * transaction pooling the client is not guaranteed to land on that same backend
 * for the next statement, so a later `EXECUTE` fails with the classic
 * `prepared statement "s0" does not exist` error. To be safe we force
 * `prepare: false` in transaction mode, which makes postgres-js send queries
 * via the unnamed/simple path and stops it from caching statements per
 * connection. See the postgres-js docs on `prepare` and PgBouncer.
 */

export interface CreatePooledDbOptions {
  /** Postgres / PgBouncer connection string. */
  url: string;
  /** Which PgBouncer pooling mode the target is running. */
  poolMode: PoolMode;
  /** Max connections in the local postgres-js pool. Default 10. */
  max?: number;
  /**
   * Whether to use named prepared statements. Honoured only in `session` mode;
   * ALWAYS forced to `false` in `transaction` mode regardless of this value.
   * Default true.
   */
  prepare?: boolean;
  /** postgres-js idle_timeout (seconds) before an idle connection is closed. */
  idleTimeout?: number;
  /** postgres-js connect_timeout (seconds) before a connect attempt fails. */
  connectTimeout?: number;
  /** postgres-js max_lifetime (seconds) before a connection is recycled. */
  maxLifetime?: number | null;
  /** PostgreSQL statement_timeout startup parameter (milliseconds). */
  statementTimeoutMs?: number;
  /** Surface NOTICE logs (default: silenced, matching createDb). */
  onNotice?: boolean;
}

const DEFAULT_MAX = 10;
const DEFAULT_IDLE_TIMEOUT = 20;
const DEFAULT_CONNECT_TIMEOUT = 30;

/**
 * Create a Drizzle client + underlying postgres.js connection configured for
 * the given PgBouncer pooling mode. Callers own the lifecycle and must
 * `close()` on shutdown.
 */
export function createPooledDb(opts: CreatePooledDbOptions) {
  const { poolMode } = opts;

  // Transaction pooling breaks named prepared statements — force them off and
  // ignore any caller/env request to enable them. Session pooling honours the
  // requested value (default on).
  const prepare = poolMode === 'transaction' ? false : (opts.prepare ?? true);

  const client = postgres(opts.url, {
    max: opts.max ?? DEFAULT_MAX,
    idle_timeout: opts.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
    connect_timeout: opts.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT,
    max_lifetime: opts.maxLifetime ?? null,
    ...(opts.statementTimeoutMs
      ? { connection: { statement_timeout: opts.statementTimeoutMs } }
      : {}),
    // `prepare: false` both disables named prepared statements and prevents
    // postgres-js from caching statements per backend connection — the two
    // behaviours that are unsafe under transaction pooling.
    prepare,
    // Silence NOTICE logs unless explicitly opted in (matches createDb).
    ...(opts.onNotice ? {} : { onnotice: () => {} }),
  });

  const db = drizzle(client, { schema, casing: 'snake_case' });

  return {
    db,
    client,
    /** The pooling mode this client was configured for. */
    poolMode,
    /** Whether named prepared statements are enabled on this client. */
    prepare,
    close: () => client.end({ timeout: 5 }),
  };
}

export type PooledDb = ReturnType<typeof createPooledDb>;
export type PooledDatabase = PooledDb['db'];
