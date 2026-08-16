import { configSchemas, loadConfig } from '@flytrace/shared';
import { z } from 'zod';

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const workerSchema = z.object({
  WORKER_GROUP: z.string().default('worker'),
  WORKER_CONSUMER: z.string().default('worker-1'),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  WORKER_BLOCK_MS: z.coerce.number().int().positive().default(5000),
  WORKER_MAX_POSITION_BATCH: z.coerce.number().int().positive().default(500),
  WATCH_MONITOR_ENABLED: configSchemas.boolish.default('true'),
  WATCH_MONITOR_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  /** How often the worker reaps expired sessions and link tokens. */
  SECURITY_JANITOR_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  WATCH_MONITOR_BATCH_SIZE: z.coerce.number().int().positive().default(40),
  WATCH_MONITOR_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(750),
  WATCH_MONITOR_MAX_POSITION_AGE_MS: z.coerce.number().int().positive().default(90_000),
  WATCH_MONITOR_END_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 60_000),
  WATCH_MONITOR_ADSB_API_URL: z.string().default('https://api.adsb.lol/v2'),
  /** Register a fixture provider for these airline IATAs (offline/demo). */
  WORKER_FIXTURE_PROVIDER_IATAS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  /**
   * Concrete provider keys to enable (e.g. "thy,pegasus"). Every real provider
   * is registered but ships disabled (docs/08 §8.6/§8.9) — enable per compliance
   * clearance without a redeploy.
   */
  WORKER_ENABLED_PROVIDERS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Base URL per provider key, JSON map (compliance/legal basis; §8.9). */
  // emptyToUndefined first: a container materialises an unset variable as "",
  // and "" is not parseable JSON. Without it the worker refuses to boot the
  // moment compose passes the key through with no value.
  WORKER_PROVIDER_STATUS_URLS: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as Record<string, string>;
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object' });
          return z.NEVER;
        }
      }),
  ),
  /** Per-provider priority for airline-IATA conflicts (higher wins), JSON map. */
  WORKER_PROVIDER_PRIORITY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .default('{}')
      .transform((v, ctx) => {
        try {
          return JSON.parse(v) as Record<string, number>;
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON object' });
          return z.NEVER;
        }
      }),
  ),
  WORKER_PROVIDER_FETCH_SCOPE: z.enum(['watched', 'all']).default('watched'),
  AERODATABOX_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  AERODATABOX_MARKETPLACE: z.preprocess(
    emptyToUndefined,
    z.enum(['apimarket', 'rapidapi']).default('apimarket'),
  ),
  AERODATABOX_BASE_URL: z.preprocess(emptyToUndefined, z.string().url().optional()),
});

const workerConfigSchema = configSchemas.base
  .merge(configSchemas.database)
  .merge(configSchemas.redis)
  .merge(configSchemas.infra)
  .merge(workerSchema);

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(): WorkerConfig {
  return loadConfig(workerConfigSchema);
}
