import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './index.ts';

/**
 * Standalone migration runner. Applied in CI/CD before deploy — never at app boot in prod.
 * Usage: `bun run src/migrate.ts` (reads DATABASE_URL).
 */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run migrations');

  const { db, client, close } = createDb({ url, max: 1 });

  // Extensions must exist before the schema migration (citext, geography types).
  console.log('[migrate] ensuring extensions…');
  await client.unsafe('CREATE EXTENSION IF NOT EXISTS postgis');
  await client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await client.unsafe('CREATE EXTENSION IF NOT EXISTS citext');

  console.log('[migrate] applying migrations…');
  await migrate(db, { migrationsFolder: new URL('../migrations', import.meta.url).pathname });
  console.log('[migrate] done');
  await close();
}

main().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
