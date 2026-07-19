/**
 * Retention policy + SQL builders for the position timeseries. Pure string
 * builders (no DB access) so they're trivially testable and can be run by a
 * scheduled worker on either backend:
 *
 *  - `postgres`  — a plain age-based DELETE. Correct everywhere; on very large
 *                  tables prefer running it in batches / a partitioned table.
 *  - `timescale` — `drop_chunks`, which drops whole chunks below the cutoff
 *                  instead of row-by-row deletes (far cheaper on a hypertable).
 */

export interface RetentionPolicy {
  /** Drop positions strictly older than this many days. Must be > 0. */
  maxAgeDays: number;
  /** Target table (defaults to flight_positions). */
  table?: string;
  /** Timestamp column used for the age cutoff (defaults to ts). */
  tsColumn?: string;
}

export interface RetentionSql {
  /** Interval literal derived from the policy, e.g. "30 days". */
  interval: string;
  /** Plain-Postgres age-based DELETE. */
  postgres: string;
  /** TimescaleDB chunk drop for the same cutoff. */
  timescale: string;
}

const DEFAULT_TABLE = 'flight_positions';
const DEFAULT_TS_COLUMN = 'ts';

/**
 * Build both the Postgres and Timescale retention statements for a policy.
 * @throws if maxAgeDays is not a positive, finite number (guards against a
 * mistyped 0/NaN turning the DELETE into a full-table wipe).
 */
export function buildRetentionSql(policy: RetentionPolicy): RetentionSql {
  const { maxAgeDays } = policy;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new Error(`buildRetentionSql: maxAgeDays must be a positive number, got ${maxAgeDays}`);
  }
  const table = policy.table ?? DEFAULT_TABLE;
  const tsColumn = policy.tsColumn ?? DEFAULT_TS_COLUMN;
  const interval = `${maxAgeDays} days`;

  return {
    interval,
    postgres: `DELETE FROM ${table} WHERE ${tsColumn} < now() - interval '${interval}';`,
    // drop_chunks removes chunks whose time range is entirely older than the
    // cutoff; requires the table to be a Timescale hypertable.
    timescale: `SELECT drop_chunks('${table}', older_than => interval '${interval}');`,
  };
}
