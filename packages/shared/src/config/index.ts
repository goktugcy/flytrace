import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/**
 * Central, Zod-validated environment loader.
 * Fail-fast: throws on boot if required vars are missing/invalid.
 * Never read process.env anywhere else — import `loadConfig()` instead.
 */

/** Locate the monorepo root (the dir containing turbo.json), walking up. */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'turbo.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let rootEnvLoaded = false;

/**
 * Load the single root `.env` into process.env, regardless of the app's cwd, so
 * the monorepo has ONE env file instead of a copy per app. Real environment
 * variables (shell/CI/Docker) always win — file values only fill gaps. Inline
 * `# comments` and surrounding quotes are stripped. Idempotent.
 */
export function loadRootEnv(): void {
  if (rootEnvLoaded) return;
  rootEnvLoaded = true;
  const root = findRepoRoot(process.cwd());
  if (!root) return;
  const file = join(root, '.env');
  if (!existsSync(file)) return;

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as string;
    let value = (match[2] ?? '').trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    value = quoted ? value.slice(1, -1) : value.replace(/\s+#.*$/, '').trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const csvList = (defaultValue = '') =>
  z
    .string()
    .default(defaultValue)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  /** Public web app base URL (deep links in notifications). */
  WEB_BASE_URL: z.string().url().default('http://localhost:3000'),
});

const databaseSchema = z.object({
  DATABASE_URL: z.string().url(),
});

const redisSchema = z.object({
  REDIS_URL: z.string().url(),
});

const apiSchema = z.object({
  API_PORT: z.coerce.number().int().positive().default(3001),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

const authSchema = z.object({
  AUTH_SECRET: z.string().min(16),
  AUTH_URL: z.string().url(),
});

const openskySchema = z.object({
  OPENSKY_CLIENT_ID: z.string().optional(),
  OPENSKY_CLIENT_SECRET: z.string().optional(),
  OPENSKY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(6000),
});

const webPushSchema = z.object({
  WEB_PUSH_PUBLIC_KEY: z.string().optional(),
  WEB_PUSH_PRIVATE_KEY: z.string().optional(),
  WEB_PUSH_SUBJECT: z.string().default('mailto:ops@flytrace.local'),
});

const telegramSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_BOT_USERNAME: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),
});

const emailSchema = z.object({
  EMAIL_FROM: z.string().default('FlyTrace <alerts@flytrace.local>'),
  EMAIL_API_KEY: z.string().optional(),
  EMAIL_API_URL: z.string().url().default('https://api.resend.com/emails'),
  /** Email adapter: mock (default, logs only) | resend | brevo | smtp. */
  EMAIL_PROVIDER: z.string().default('mock'),
});

// Cross-cutting infra: secret store, tracing, and generic provider selection.
// All optional with safe local defaults so nothing external is required.
const infraSchema = z.object({
  SECRET_PROVIDER: z.string().default('env'),
  INFISICAL_API_URL: z.string().url().optional(),
  INFISICAL_TOKEN: z.string().optional(),
  INFISICAL_PROJECT_ID: z.string().optional(),
  INFISICAL_ENV: z.string().optional(),
  VAULT_ADDR: z.string().url().optional(),
  VAULT_TOKEN: z.string().optional(),
  VAULT_KV_MOUNT: z.string().optional(),
  VAULT_SECRET_PATH: z.string().optional(),
  OTEL_TRACES_EXPORTER: z.enum(['noop', 'console', 'otlp']).default('noop'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  // Timeseries (Phase 3 §4): flight-position backend.
  TIMESERIES_BACKEND: z.enum(['postgres', 'timescale']).default('postgres'),
  // Airspace (Phase 3 §1): provider + optional dataset paths.
  AIRSPACE_PROVIDER: z.string().default('mock'),
  AIRSPACE_DB_SOURCE_PROVIDER: z.string().default('openaip'),
  OPENAIP_API_KEY: z.string().optional(),
  OPENAIP_GLOBAL_IMPORT: boolish.default('false'),
  OPENAIP_BASE_URL: z.string().url().default('https://api.core.openaip.net/api'),
  OPENAIP_COUNTRY: z.string().optional(),
  OPENAIP_BBOX: z.string().optional(),
  OPENAIP_PAGE_LIMIT: z.coerce.number().int().positive().default(1000),
  OPENAIP_IMPORT_PAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(500),
  OPENAIP_IMPORT_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  OPENAIP_DATASET_PATH: z.string().optional(),
  OPENFLIGHTMAPS_DATASET_PATH: z.string().optional(),
  AIXM_DATASET_PATH: z.string().optional(),
  AIRSPACE_DATASET_VERSION: z.string().default('local-fixture'),
  AIRSPACE_IMPORT_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  AIRSPACE_RETIRE_PREVIOUS_VERSIONS: boolish.default('true'),
  AIRSPACE_RETIRE_MISSING: boolish.default('false'),
  // Connection pooling (Phase 3 §5): PgBouncer-ready.
  DB_POOL_MODE: z.enum(['session', 'transaction']).optional(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_POOL_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  DB_POOL_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_POOL_MAX_LIFETIME_MS: z.coerce.number().int().positive().default(1_800_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  PG_POOL_MODE: z.enum(['session', 'transaction']).default('session'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),
  PG_PREPARE: boolish.default('true'),
  // Backup / DR (Phase 3 §9).
  BACKUP_PROVIDER: z.enum(['mock', 'pgdump']).default('mock'),
  BACKUP_DIR: z.string().optional(),
  WAL_ARCHIVE_DIR: z.string().optional(),
  // Digest email (Phase 3 §2).
  DIGEST_ENABLED: boolish.default('false'),
  DIGEST_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  BREVO_API_KEY: z.string().optional(),
  SMTP_URL: z.string().optional(),
});

// WebSocket horizontal scaling (Phase 3 §3).
const wsSchema = z.object({
  WS_PUBSUB_BACKEND: z.enum(['memory', 'redis']).default('memory'),
  WS_PRESENCE_BACKEND: z.enum(['memory', 'redis']).default('memory'),
  WS_RATELIMIT_BACKEND: z.enum(['memory']).default('memory'),
  REDIS_PUBSUB_MODE: z.enum(['standard', 'sharded']).default('standard'),
  WS_SHARD_COUNT: z.coerce.number().int().positive().default(64),
  WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WS_MAX_CONNS_PER_IP: z.coerce.number().int().positive().default(10),
  WS_MAX_MSGS_PER_SEC: z.coerce.number().int().positive().default(20),
});

// Security hardening (Phase 3 §7): edge + session.
const securitySchema = z.object({
  TURNSTILE_ENABLED: boolish.default('false'),
  TURNSTILE_SECRET: z.string().optional(),
  TURNSTILE_FAIL_OPEN: boolish.default('false'),
  TURNSTILE_EXPECTED_ACTION: z.string().default('turnstile-spin-v1'),
  TURNSTILE_EXPECTED_HOSTNAME: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  CSP_MODE: z.enum(['off', 'report-only', 'enforce']).default('off'),
  CSP_REPORT_URI: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  CSP_CONNECT_SRC: csvList(),
  CSP_IMG_SRC: csvList(),
  CSP_SCRIPT_SRC: csvList(),
  CSP_STYLE_SRC: csvList(),
  CSP_FONT_SRC: csvList(),
  CSP_FRAME_SRC: csvList(),
  // ── Rate limiting ──
  // The backend is validated here; `resolveRateLimiter` additionally REFUSES
  // the memory backend in production (per-process counters multiply every limit
  // by the instance count).
  RATE_LIMIT_BACKEND: z.enum(['memory', 'redis']).default('memory'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // Per-category policies. Defaults are tuned for "a real user never notices,
  // an online guesser gives up"; every one is overridable per environment.
  RATE_LIMIT_LOGIN_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_LOGIN_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  RATE_LIMIT_SIGNUP_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_SIGNUP_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  RATE_LIMIT_MFA_CHALLENGE_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MFA_CHALLENGE_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  RATE_LIMIT_MFA_VERIFY_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_MFA_VERIFY_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  RATE_LIMIT_REFRESH_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_REFRESH_WINDOW_MS: z.coerce.number().int().positive().default(300_000),
  RATE_LIMIT_PASSWORD_RESET_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_PASSWORD_RESET_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),
  RATE_LIMIT_WS_TICKET_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_WS_TICKET_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_SECURITY_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_SECURITY_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_ADMIN_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ADMIN_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_OPS_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_OPS_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  AUDIT_BACKEND: z.enum(['memory', 'db']).default('memory'),

  // ── Sessions, refresh tokens, cookies ──
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  SESSION_REFRESH_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  /**
   * Grace window in which re-presenting a just-rotated refresh token counts as
   * a benign in-flight retry rather than an attack. 0 disables it (strictest).
   */
  REFRESH_TOKEN_REUSE_GRACE_MS: z.coerce.number().int().nonnegative().default(10_000),
  SESSION_COOKIE_SAMESITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  SESSION_COOKIE_DOMAIN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().optional(),
  ),
  /**
   * How much of a client address may be persisted. `prefix` (default) stores
   * the /24 (v4) or /48 (v6) network — enough for new-network detection,
   * without retaining an exact address as personal data.
   */
  SECURITY_IP_STORAGE: z.enum(['prefix', 'full', 'none']).default('prefix'),
  /** Send out-of-band alerts on new devices, token reuse, credential changes. */
  SECURITY_NOTIFICATIONS_ENABLED: boolish.default('true'),
  /** Lifetime of email-verification and Telegram deep-link tokens. */
  LINK_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().max(10_080).default(1440),

  IMPOSSIBLE_TRAVEL_MAX_KMH: z.coerce.number().positive().default(900),

  // ── MFA ──
  MFA_ISSUER: z.string().default('FlyTrace'),
  MFA_SECRET_ENCRYPTION_KEY: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(16).optional(),
  ),
  /** Where login-time MFA challenges live. `memory` is rejected in production. */
  MFA_CHALLENGE_BACKEND: z.enum(['redis', 'memory']).default('redis'),
  /** Challenge lifetime; clamped to 60–600s by the service. */
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(300),
  /** Failed code attempts tolerated before a challenge is burned. */
  MFA_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  // ── Operational endpoints (/metrics, /health/detailed) ──
  /** Bearer token for internal scrapers. REQUIRED outside local development. */
  INTERNAL_API_TOKEN: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().min(32).optional(),
  ),
  /** Opt out of the token check when access is already restricted by network. */
  INTERNAL_ENDPOINTS_NETWORK_ONLY: boolish.default('false'),
});

/** Compose the schemas an app needs; each app validates only its slice. */
export const configSchemas = {
  base: baseSchema,
  database: databaseSchema,
  redis: redisSchema,
  api: apiSchema,
  auth: authSchema,
  opensky: openskySchema,
  webPush: webPushSchema,
  telegram: telegramSchema,
  email: emailSchema,
  infra: infraSchema,
  ws: wsSchema,
  security: securitySchema,
  boolish,
};

const fullSchema = baseSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(apiSchema)
  .merge(authSchema)
  .merge(openskySchema)
  .merge(webPushSchema)
  .merge(telegramSchema)
  .merge(emailSchema)
  .merge(infraSchema)
  .merge(wsSchema)
  .merge(securitySchema);

export type Config = z.infer<typeof fullSchema>;

/**
 * Validate `source` (defaults to process.env) against a schema.
 * @throws with a readable message listing every invalid/missing var.
 */
export function loadConfig<S extends z.ZodTypeAny = typeof fullSchema>(
  schema?: S,
  source?: Record<string, unknown>,
): z.infer<S> {
  // Fill process.env from the single root .env (missing keys only) before read.
  loadRootEnv();
  const effectiveSource = source ?? process.env;
  const effective = (schema ?? fullSchema) as z.ZodTypeAny;
  const parsed = effective.safeParse(effectiveSource);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export { fullSchema as configSchema };
