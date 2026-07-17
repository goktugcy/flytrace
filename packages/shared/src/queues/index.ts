import { z } from 'zod';

/**
 * BullMQ queue contracts (docs/09 §9.7). Queue names + job-data schemas are
 * shared so producers (api/worker/scheduler) and consumers (worker) agree; the
 * BullMQ Queue/Worker wiring (ioredis-bound) lives in the apps.
 */
export const QUEUES = {
  providerFetch: 'provider.fetch',
  persistPositions: 'persist.positions',
  notifySend: 'notify.send',
} as const;

export const providerFetchJobSchema = z.object({
  flightId: z.string().uuid(),
  airlineIata: z.string(),
  flightNumber: z.string(),
  date: z.string(), // YYYY-MM-DD
});
export type ProviderFetchJob = z.infer<typeof providerFetchJobSchema>;
