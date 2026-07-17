import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.ts';

export * as schema from './schema/index.ts';
export { sql, eq, and, or, desc, asc, inArray } from 'drizzle-orm';
export * from './repos/flights.ts';
export * from './repos/flights-read.ts';
export * from './repos/auth.ts';
export * from './repos/notify.ts';
export * from './repos/flight-status.ts';

export type Database = ReturnType<typeof createDb>['db'];

export interface CreateDbOptions {
  url: string;
  max?: number;
  onNotice?: boolean;
}

/**
 * Create a Drizzle client + underlying postgres.js connection.
 * Callers own the lifecycle and must `close()` on shutdown.
 */
export function createDb(opts: CreateDbOptions) {
  const client = postgres(opts.url, {
    max: opts.max ?? 10,
    // Silence NOTICE logs unless explicitly opted in.
    ...(opts.onNotice ? {} : { onnotice: () => {} }),
  });
  const db = drizzle(client, { schema, casing: 'snake_case' });
  return {
    db,
    client,
    close: () => client.end({ timeout: 5 }),
  };
}
