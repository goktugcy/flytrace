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
  .merge(emailSchema);

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
