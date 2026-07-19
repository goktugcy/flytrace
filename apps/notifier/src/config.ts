import { configSchemas, loadConfig } from '@flytrace/shared';
import { z } from 'zod';

const notifierSchema = z.object({
  NOTIFIER_GROUP: z.string().default('notifier'),
  NOTIFIER_CONSUMER: z.string().default('notifier-1'),
  NOTIFIER_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  NOTIFIER_BLOCK_MS: z.coerce.number().int().positive().default(5000),
  /** Use an in-memory push sender (offline dev / pipeline smoke). */
  NOTIFIER_FAKE_PUSH: configSchemas.boolish.default('false'),
  /** Max non-critical notifications per flight per hour (docs/10 §10.7). */
  NOTIFIER_FREQUENCY_CAP: z.coerce.number().int().positive().default(5),
});

const notifierConfigSchema = configSchemas.base
  .merge(configSchemas.database)
  .merge(configSchemas.redis)
  .merge(configSchemas.infra)
  .merge(configSchemas.webPush)
  .merge(configSchemas.telegram)
  .merge(configSchemas.email)
  .merge(notifierSchema);

export type NotifierConfig = z.infer<typeof notifierConfigSchema>;

export function loadNotifierConfig(): NotifierConfig {
  return loadConfig(notifierConfigSchema);
}
