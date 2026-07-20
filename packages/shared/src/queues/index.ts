import { z } from 'zod';

/**
 * BullMQ queue contracts (docs/09 §9.7). Queue names + job-data schemas are
 * shared so producers (api/worker/scheduler) and consumers (worker) agree; the
 * BullMQ Queue/Worker wiring (ioredis-bound) lives in the apps.
 */
export const QUEUES = {
  airspaceImport: 'airspace.import',
  providerFetch: 'provider.fetch',
  persistPositions: 'persist.positions',
  notifySend: 'notify.send',
} as const;

export const airspaceImportJobSchema = z.object({
  provider: z.literal('openaip'),
  scope: z.literal('global'),
  datasetVersion: z.string().min(1),
  triggeredByUserId: z.string().uuid().nullable().optional(),
  requestedAt: z.string().datetime(),
});
export type AirspaceImportJob = z.infer<typeof airspaceImportJobSchema>;

export const providerFetchJobSchema = z.object({
  flightId: z.string().uuid(),
  airlineIata: z.string(),
  flightNumber: z.string(),
  date: z.string(), // YYYY-MM-DD
  callsign: z.string().nullable().optional(),
  icao24: z.string().nullable().optional(),
});
export type ProviderFetchJob = z.infer<typeof providerFetchJobSchema>;
