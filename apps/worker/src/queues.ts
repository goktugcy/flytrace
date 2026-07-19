import { QUEUES, airspaceImportJobSchema, providerFetchJobSchema } from '@flytrace/shared';
import type { Logger } from '@flytrace/shared';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AirspaceImportService } from './airspace-import.ts';
import type { ProviderFetchService } from './provider-fetch.ts';

/**
 * BullMQ wiring for the provider-fetch pipeline (docs/09 §9.7): a rate-limited,
 * retrying queue. The queue (producer) and worker (consumer) share the Redis
 * connection; job data is Zod-validated before processing (poison → no retry).
 */
export interface ProviderQueueOptions {
  rateLimit: { max: number; durationMs: number };
  concurrency: number;
  attempts: number;
}

export const DEFAULT_PROVIDER_QUEUE: ProviderQueueOptions = {
  rateLimit: { max: 10, durationMs: 1000 },
  concurrency: 4,
  attempts: 5,
};

export function createProviderFetchQueue(connection: Redis): Queue {
  return new Queue(QUEUES.providerFetch, {
    connection,
    defaultJobOptions: {
      attempts: DEFAULT_PROVIDER_QUEUE.attempts,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}

export function createAirspaceImportQueue(connection: Redis): Queue {
  return new Queue(QUEUES.airspaceImport, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 20,
      removeOnFail: 100,
    },
  });
}

export function startProviderFetchWorker(
  connection: Redis,
  service: ProviderFetchService,
  logger: Logger,
  opts: ProviderQueueOptions = DEFAULT_PROVIDER_QUEUE,
): Worker {
  const worker = new Worker(
    QUEUES.providerFetch,
    async (job) => {
      const parsed = providerFetchJobSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error('provider.fetch malformed job', { id: job.id });
        return; // poison → ack without retry
      }
      await service.process(parsed.data);
    },
    {
      connection,
      concurrency: opts.concurrency,
      limiter: { max: opts.rateLimit.max, duration: opts.rateLimit.durationMs },
    },
  );
  worker.on('failed', (job, err) =>
    logger.error('provider.fetch failed', { id: job?.id, err: String(err) }),
  );
  return worker;
}

export function startAirspaceImportWorker(
  connection: Redis,
  service: AirspaceImportService,
  logger: Logger,
): Worker {
  const worker = new Worker(
    QUEUES.airspaceImport,
    async (job) => {
      const parsed = airspaceImportJobSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error('airspace.import malformed job', { id: job.id });
        return;
      }
      return await service.process(job);
    },
    {
      connection,
      concurrency: 1,
      limiter: { max: 1, duration: 1000 },
    },
  );
  worker.on('failed', (job, err) =>
    logger.error('airspace.import failed', { id: job?.id, err: String(err) }),
  );
  return worker;
}
