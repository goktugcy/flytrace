import { createLogger, systemClock } from '@flytrace/shared';
/**
 * Test fixtures for the API composition root.
 *
 * The config is produced by running the REAL Zod schema, so a test context can
 * never drift from production defaults: adding a required setting breaks these
 * fixtures immediately instead of letting route tests pass against a config
 * shape the app would reject at boot.
 */
import type { Queue } from 'bullmq';
import { type ApiConfig, apiConfigSchema } from '../config.ts';
import type { AppContext } from '../context.ts';

/** The minimum a real deployment must supply; everything else is defaulted. */
const REQUIRED_ENV = {
  DATABASE_URL: 'postgres://flytrace:flytrace@localhost:5432/flytrace_test',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'test-auth-secret-at-least-16-chars',
  AUTH_URL: 'http://localhost:3001',
  APP_ENV: 'local',
  CORS_ORIGINS: 'http://localhost:3000',
  // Process-local stores are fine in a single-process test, and this keeps the
  // fixtures from needing a live Redis.
  MFA_CHALLENGE_BACKEND: 'memory',
  RATE_LIMIT_BACKEND: 'memory',
} as const;

/** A fully-defaulted ApiConfig, with overrides applied on top. */
export function testApiConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return { ...apiConfigSchema.parse({ ...REQUIRED_ENV }), ...overrides } as ApiConfig;
}

export interface TestContextOptions {
  config?: Partial<ApiConfig>;
  /** Rows returned by every `db.execute` call. */
  dbRows?: unknown[];
  db?: Partial<AppContext['db']>;
  redis?: Partial<AppContext['redis']>;
  providerQueue?: Queue;
}

/**
 * A minimal but structurally-complete {@link AppContext}. `db` and `redis` are
 * inert stubs — routes that actually touch them should inject their own.
 */
export function testContext(opts: TestContextOptions = {}): AppContext {
  return {
    config: testApiConfig(opts.config),
    logger: createLogger({ level: 'error', base: {} }),
    clock: systemClock,
    db: opts.db ?? { execute: async () => (opts.dbRows ?? []) as unknown[] },
    redis: opts.redis ?? {},
    redisPrefix: 'test:',
    ...(opts.providerQueue ? { providerQueue: opts.providerQueue } : {}),
    close: async () => {},
  } as unknown as AppContext;
}
