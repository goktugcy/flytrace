/**
 * Post-`drizzle-kit generate` fixup.
 *
 * drizzle-kit only leaves a column's SQL type unquoted when it starts with a
 * type in its built-in `NativeTypes` list. That list contains `geometry` but
 * NOT `geography`, so PostGIS `geography(Point,4326)` columns are emitted as a
 * quoted identifier — `"geography(Point,4326)"` — which Postgres then treats as
 * an (undefined) type name and rejects with 42704. We use `geography` on
 * purpose (spheroidal, metre-accurate distances; see docs/05-database.md), so we
 * strip the erroneous quoting from every generated migration instead.
 *
 * Wired into `db:generate` so regenerating the schema stays correct.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationsDir = new URL('../migrations', import.meta.url).pathname;
const QUOTED_GEOGRAPHY = /"(geography\([^"]*\))"/g;

let touched = 0;
for (const file of readdirSync(migrationsDir)) {
  if (!file.endsWith('.sql')) continue;
  const path = join(migrationsDir, file);
  const original = readFileSync(path, 'utf8');
  const fixed = original.replace(QUOTED_GEOGRAPHY, '$1');
  if (fixed !== original) {
    writeFileSync(path, fixed);
    touched += 1;
    console.log(`[fix-postgis] unquoted geography types in ${file}`);
  }
}

console.log(`[fix-postgis] done (${touched} file(s) updated)`);
