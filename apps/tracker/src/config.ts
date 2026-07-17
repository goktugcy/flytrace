import { configSchemas, loadConfig } from '@flytrace/shared/config';
import { z } from 'zod';

/**
 * A geographic bounding box for scoping OpenSky `/states/all` polls
 * (see docs/08 §8.3). Format: "lamin,lomin,lamax,lomax" (WGS84 degrees).
 * Default covers Türkiye + surrounding airspace.
 */
const bboxSchema = z
  .string()
  .default('35.0,25.0,43.0,45.0')
  .transform((v, ctx) => {
    const parts = v.split(',').map((s) => Number(s.trim()));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TRACKER_BBOX must be "lamin,lomin,lamax,lomax"',
      });
      return z.NEVER;
    }
    const [lamin, lomin, lamax, lomax] = parts as [number, number, number, number];
    return { lamin, lomin, lamax, lomax };
  });

const trackerSchema = z.object({
  /** How long a leader/shard lock is held before it must be renewed (ms). */
  TRACKER_LOCK_TTL_MS: z.coerce.number().int().positive().default(15_000),
  /** Idle time after last position before a flight is force-ended (ms). */
  TRACKER_FLIGHT_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  TRACKER_BBOX: bboxSchema,
  /** Use the recorded fixture feed instead of live OpenSky (offline dev). */
  TRACKER_USE_FIXTURE: configSchemas.boolish.default('false'),
});

const trackerConfigSchema = configSchemas.base
  .merge(configSchemas.redis)
  .merge(configSchemas.opensky)
  .merge(trackerSchema);

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;
export type Bbox = TrackerConfig['TRACKER_BBOX'];

export function loadTrackerConfig(): TrackerConfig {
  return loadConfig(trackerConfigSchema);
}
