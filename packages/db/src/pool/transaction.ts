/**
 * `withTransaction` — a typed helper that runs `fn` inside a single database
 * transaction with correct BEGIN/COMMIT/ROLLBACK boundaries.
 *
 * Why delegate to drizzle/postgres-js `.transaction()` instead of issuing
 * `BEGIN`/`COMMIT` via separate `execute()` calls?
 *
 * postgres-js hands each statement whatever pooled connection is free, so
 * issuing `BEGIN` and `COMMIT` as independent statements could run them on
 * *different* backend connections — the transaction would silently span
 * connections and break. drizzle's `.transaction()` is built on postgres-js's
 * reserved-connection primitive (`sql.begin`): it pins ONE connection for the
 * whole callback, emits `BEGIN` up front, `COMMIT` on success, and `ROLLBACK`
 * if the callback throws. That single-connection guarantee is exactly what
 * makes it safe under PgBouncer transaction pooling — the entire unit of work
 * borrows one server connection and returns it only after COMMIT/ROLLBACK.
 *
 * This wrapper is intentionally thin: it adds a stable, injectable seam (so
 * callers and tests depend on a small structural interface rather than the full
 * drizzle type) and guarantees errors propagate, so the underlying driver
 * performs the ROLLBACK. It does NOT catch/swallow errors.
 */

/**
 * Structural subset of a drizzle database exposing `.transaction()`.
 * `Tx` is the transaction handle passed to the callback (a drizzle
 * transaction, structurally the same as the db for query purposes).
 */
export interface TransactionalDb<Tx = unknown> {
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

/**
 * Run `fn` in a single transaction. Commits if `fn` resolves, rolls back if it
 * rejects (the rejection is re-thrown to the caller). Safe under PgBouncer
 * transaction pooling because the underlying driver pins one connection for the
 * whole callback.
 */
export function withTransaction<Tx, T>(
  db: TransactionalDb<Tx>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
