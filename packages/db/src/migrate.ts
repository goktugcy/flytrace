import { loadRootEnv } from '@flytrace/shared';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './index.ts';

/**
 * Standalone migration runner. Applied by the dedicated one-shot migration job
 * before app containers start — never at app boot in prod (see
 * docs/18-production.md). Usage: `bun run src/migrate.ts` (reads DATABASE_URL).
 *
 * Concurrency: the whole run is wrapped in a Postgres *session* advisory lock,
 * so two migration jobs racing (a re-deploy, a retried k8s Job, two operators)
 * serialise instead of both trying to ALTER the same tables. The second holder
 * finds the migration table already up to date and exits as a no-op. The lock
 * is advisory-only — it never blocks application traffic — and is released
 * automatically when the connection closes, including on a hard crash.
 */

/** Arbitrary but stable 64-bit key; must match across every deploy. */
const MIGRATION_LOCK_KEY = 8_215_530_411_927_001n;
const LOCK_WAIT_TIMEOUT_MS = Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 120_000);

async function main() {
  // Fill process.env from the single root .env so `bun run db:migrate` works
  // from a fresh checkout, exactly like every app's loadConfig() does. Real
  // environment variables (CI, Docker) always win — the file only fills gaps,
  // so the migration job container is unaffected.
  loadRootEnv();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

  const { db, client, close } = createDb({ url, max: 1 });

  console.log('[migrate] acquiring advisory lock…');
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    const [row] = await client.unsafe<{ locked: boolean }[]>(
      `select pg_try_advisory_lock(${MIGRATION_LOCK_KEY}) as locked`,
    );
    if (row?.locked) break;
    if (Date.now() >= deadline) {
      await close();
      throw new Error(
        `another migration job holds the advisory lock (waited ${LOCK_WAIT_TIMEOUT_MS}ms)`,
      );
    }
    console.log('[migrate] lock held by another job, retrying in 2s…');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  try {
    // Extensions must exist before the schema migration (citext, geography
    // types, and pgcrypto's digest() for the 0005 token-hash backfill).
    console.log('[migrate] ensuring extensions…');
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS postgis');
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS citext');
    await client.unsafe('CREATE EXTENSION IF NOT EXISTS pgcrypto');

    console.log('[migrate] applying migrations…');
    await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
    console.log('[migrate] done');
  } finally {
    await client.unsafe(`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`).catch(() => {});
    await close();
  }
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
