import { describe, expect, test } from 'bun:test';
import { type TransactionalDb, withTransaction } from './transaction.ts';

/**
 * Fake db emulating drizzle/postgres-js transaction semantics so we can assert
 * boundary calls without a real database: BEGIN up front, COMMIT on resolve,
 * ROLLBACK on throw. `tx` is a sentinel handle handed to the callback.
 */
function makeFakeDb() {
  const calls: string[] = [];
  const tx = { __tx: true } as const;
  const db: TransactionalDb<typeof tx> = {
    async transaction<T>(fn: (t: typeof tx) => Promise<T>): Promise<T> {
      calls.push('begin');
      try {
        const result = await fn(tx);
        calls.push('commit');
        return result;
      } catch (err) {
        calls.push('rollback');
        throw err;
      }
    },
  };
  return { db, calls, tx };
}

describe('withTransaction', () => {
  test('happy path: begin → commit, returns the callback value and passes tx', async () => {
    const { db, calls, tx } = makeFakeDb();
    let received: unknown;

    const result = await withTransaction(db, async (t) => {
      received = t;
      return 42;
    });

    expect(result).toBe(42);
    expect(received).toBe(tx);
    expect(calls).toEqual(['begin', 'commit']);
  });

  test('throwing callback: begin → rollback, and the error propagates (no commit)', async () => {
    const { db, calls } = makeFakeDb();
    const boom = new Error('boom');

    await expect(
      withTransaction(db, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(calls).toEqual(['begin', 'rollback']);
    expect(calls).not.toContain('commit');
  });
});
