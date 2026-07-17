import { z } from 'zod';

/**
 * Central, Zod-validated environment loader.
 * Fail-fast: throws on boot if required vars are missing/invalid.
 * Never read process.env anywhere else — import `loadConfig()` instead.
 */

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
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

/** Compose the schemas an app needs; each app validates only its slice. */
export const configSchemas = {
  base: baseSchema,
  database: databaseSchema,
  redis: redisSchema,
  api: apiSchema,
  auth: authSchema,
  opensky: openskySchema,
  webPush: webPushSchema,
  boolish,
};

const fullSchema = baseSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(apiSchema)
  .merge(authSchema)
  .merge(openskySchema)
  .merge(webPushSchema);

export type Config = z.infer<typeof fullSchema>;

/**
 * Validate `source` (defaults to process.env) against a schema.
 * @throws with a readable message listing every invalid/missing var.
 */
export function loadConfig<S extends z.ZodTypeAny = typeof fullSchema>(
  schema?: S,
  source: Record<string, unknown> = process.env,
): z.infer<S> {
  const effective = (schema ?? fullSchema) as z.ZodTypeAny;
  const parsed = effective.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export { fullSchema as configSchema };
