import { configSchemas, loadConfig } from '@flytrace/shared';
import { z } from 'zod';

const workerSchema = z.object({
  WORKER_GROUP: z.string().default('worker'),
  WORKER_CONSUMER: z.string().default('worker-1'),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(200),
  WORKER_BLOCK_MS: z.coerce.number().int().positive().default(5000),
  WORKER_MAX_POSITION_BATCH: z.coerce.number().int().positive().default(500),
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
});

const workerConfigSchema = configSchemas.base
  .merge(configSchemas.database)
  .merge(configSchemas.redis)
  .merge(workerSchema);

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(): WorkerConfig {
  return loadConfig(workerConfigSchema);
}
