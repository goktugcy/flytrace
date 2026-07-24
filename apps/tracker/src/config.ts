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

const trackerProviderSchema = z.enum(['opensky', 'adsb']);
export type TrackerProviderName = z.infer<typeof trackerProviderSchema>;

const providerListSchema = z
  .string()
  .default('opensky,adsb')
  .transform((v, ctx): TrackerProviderName[] => {
    const out: TrackerProviderName[] = [];
    for (const raw of v.split(',')) {
      const item = raw.trim().toLowerCase();
      if (!item) continue;
      const parsed = trackerProviderSchema.safeParse(item);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `unknown tracker provider "${item}"`,
        });
        return z.NEVER;
      }
      if (!out.includes(parsed.data)) out.push(parsed.data);
    }
    if (out.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'TRACKER_PROVIDERS must include at least one provider',
      });
      return z.NEVER;
    }
    return out;
  });

const providerPrioritySchema = z
  .string()
  .default('adsb:20,opensky:10')
  .transform((v, ctx): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const raw of v.split(',')) {
      const item = raw.trim();
      if (!item) continue;
      const [provider, value, extra] = item.split(':');
      const key = provider?.trim().toLowerCase();
      const priority = Number(value?.trim());
      if (extra !== undefined || !key || !trackerProviderSchema.safeParse(key).success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid provider priority entry "${item}"`,
        });
        return z.NEVER;
      }
      if (!Number.isFinite(priority)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid provider priority value "${item}"`,
        });
        return z.NEVER;
      }
      out[key] = priority;
    }
    return out;
  });

const trackerSchema = z.object({
  /** How long a leader/shard lock is held before it must be renewed (ms). */
  TRACKER_LOCK_TTL_MS: z.coerce.number().int().positive().default(15_000),
  /** Deprecated: kept for old env files; use TRACKER_REMOVE_AFTER_MS instead. */
  TRACKER_FLIGHT_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  TRACKER_LIVE_AFTER_MS: z.coerce.number().int().positive().default(15_000),
  TRACKER_DELAYED_AFTER_MS: z.coerce.number().int().positive().default(30_000),
  TRACKER_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  TRACKER_REMOVE_AFTER_MS: z.coerce.number().int().positive().default(90_000),
  TRACKER_MAX_POSITION_AGE_MS: z.coerce.number().int().positive().default(30_000),
  TRACKER_BBOX: bboxSchema,
  /**
   * Position source. `adsb` (default) uses a keyless community ADS-B feed
   * (adsb.lol) with generous limits; `opensky` uses OpenSky (credit-limited);
   * `fixture` replays a recording offline.
   */
  TRACKER_SOURCE: z.enum(['adsb', 'opensky', 'composite', 'fixture']).default('adsb'),
  TRACKER_PROVIDERS: providerListSchema,
  TRACKER_PROVIDER_SWITCH_MARGIN: z.coerce.number().min(0).default(0.15),
  TRACKER_PROVIDER_MAX_JUMP_SPEED_KT: z.coerce.number().positive().default(1200),
  TRACKER_PROVIDER_PRIORITY: providerPrioritySchema,
  /** Use the recorded fixture feed (offline dev). Overrides TRACKER_SOURCE when set. */
  TRACKER_USE_FIXTURE: configSchemas.boolish.default('false'),
  /** Community ADS-B feed (readsb/tar1090 JSON). */
  ADSB_API_URL: z.string().default('https://api.adsb.lol/v2'),
  /**
   * Query path shape: 'lol' → /lat/../lon/../dist/.. (adsb.lol, adsb.fi);
   * 'point' → /point/{lat}/{lon}/{radius} (airplanes.live). Match it to ADSB_API_URL.
   */
  ADSB_QUERY_STYLE: z.enum(['lol', 'point']).default('lol'),
  /**
   * Optional multiple ADS-B feeds, combined in composite mode for wider receiver
   * coverage (community aggregators share many feeders, so the union is only
   * modestly larger). Format: "url|style,url|style" (style = lol | point). When
   * unset, the single ADSB_API_URL/ADSB_QUERY_STYLE is used.
   */
  ADSB_FEEDS: z.string().optional(),
  /** ADS-B query centre + radius (nm). Türkiye-centric defaults; adsb.lol caps at 250. */
  ADSB_CENTER_LAT: z.coerce.number().default(39.0),
  ADSB_CENTER_LON: z.coerce.number().default(35.0),
  ADSB_RADIUS_NM: z.coerce.number().int().positive().default(250),
  /**
   * Poll cadence for the adsb.lol feed. Keyless with generous limits, so we can
   * refresh far more often than OpenSky — fresher positions mean the map lags
   * the real aircraft less (the client also dead-reckons between updates).
   */
  ADSB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // Airport ground-ops engine (Phase 3; off by default, additive). Reads
  // airport geometry from Postgres once at boot; requires DATABASE_URL when on.
  AIRPORT_GROUND_ENABLED: configSchemas.boolish.default('false'),
  DATABASE_URL: z.string().url().optional(),
  AIRPORT_GROUND_MAX_KM: z.coerce.number().positive().default(8),
  AIRPORT_GROUND_ALT_FT: z.coerce.number().int().positive().default(10_000),
  /**
   * Prometheus scrape server for the tracker's process-local metrics registry.
   * The tracker is a poll loop with no HTTP surface otherwise; this exposes
   * GET /metrics (+ /health) so Prometheus can scrape it. 0 disables the server.
   */
  TRACKER_METRICS_PORT: z.coerce.number().int().min(0).default(9101),
  TRACKER_METRICS_HOST: z.string().default('0.0.0.0'),
});

const trackerConfigSchema = configSchemas.base
  .merge(configSchemas.redis)
  .merge(configSchemas.opensky)
  .merge(trackerSchema)
  .superRefine((cfg, ctx) => {
    if (
      cfg.TRACKER_LIVE_AFTER_MS >= cfg.TRACKER_DELAYED_AFTER_MS ||
      cfg.TRACKER_DELAYED_AFTER_MS >= cfg.TRACKER_STALE_AFTER_MS ||
      cfg.TRACKER_STALE_AFTER_MS >= cfg.TRACKER_REMOVE_AFTER_MS
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'tracker lifecycle thresholds must increase: LIVE < DELAYED < STALE < REMOVE',
      });
    }
  });

export type TrackerConfig = z.infer<typeof trackerConfigSchema>;
export type Bbox = TrackerConfig['TRACKER_BBOX'];

export function loadTrackerConfig(): TrackerConfig {
  return loadConfig(trackerConfigSchema);
}
