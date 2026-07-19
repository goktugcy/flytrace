import { type LiveFlight, flightQualityStateSchema } from '@flytrace/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { type Bbox, inBbox } from '../ws/channels.ts';

/**
 * Reads the tracker's hot flight state from Redis (docs/09 §9.8) for the live
 * read path — GET /flights/live and /stats/live serve from here without
 * touching Postgres. (The WS gateway reads the same keys for its viewport
 * snapshot; this is the REST-side reader.)
 */
const hotStateSchema = z
  .object({
    flightId: z.string(),
    icao24: z.string(),
    callsign: z.string().nullable(),
    lat: z.number(),
    lon: z.number(),
    altFt: z.number().nullable(),
    geoAltitudeFt: z.number().nullable().optional(),
    headingDeg: z.number().nullable(),
    gsKt: z.number().nullable(),
    vrateFpm: z.number().nullable().optional(),
    airborne: z.boolean(),
    squawk: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    lastTs: z.string(),
    qualityState: flightQualityStateSchema.optional(),
    lastAcceptedAt: z.string().optional(),
    selectedProvider: z.string().optional(),
    sourceTimestamp: z.string().optional(),
    ageMs: z.number().optional(),
    qualityScore: z.number().optional(),
    positionSource: z.string().optional(),
    isMlat: z.boolean().optional(),
  })
  .passthrough();

export function createHotState(redis: Redis, prefix: string) {
  const activeKey = `${prefix}flights:active`;
  const stateKey = (id: string): string => `${prefix}flight:state:${id}`;

  const toLive = (s: z.infer<typeof hotStateSchema>): LiveFlight => ({
    flightId: s.flightId,
    icao24: s.icao24,
    callsign: s.callsign,
    lat: s.lat,
    lon: s.lon,
    altitudeFt: s.altFt,
    ...(s.geoAltitudeFt !== undefined ? { geoAltitudeFt: s.geoAltitudeFt } : {}),
    headingDeg: s.headingDeg,
    groundSpeedKt: s.gsKt,
    ...(s.vrateFpm !== undefined ? { verticalRateFpm: s.vrateFpm } : {}),
    onGround: !s.airborne,
    ...(s.squawk !== undefined ? { squawk: s.squawk } : {}),
    ...(s.category !== undefined ? { category: s.category } : {}),
    ...(s.qualityState !== undefined ? { qualityState: s.qualityState } : {}),
    ...(s.selectedProvider !== undefined ? { source: s.selectedProvider } : {}),
    ...(s.sourceTimestamp !== undefined ? { sourceTimestamp: s.sourceTimestamp } : {}),
    ...(s.ageMs !== undefined ? { ageMs: Math.max(0, Math.round(s.ageMs)) } : {}),
    ...(s.qualityScore !== undefined ? { qualityScore: s.qualityScore } : {}),
    ...(s.positionSource !== undefined ? { positionSource: s.positionSource } : {}),
    ...(s.isMlat !== undefined ? { isMlat: s.isMlat } : {}),
    ...(s.lastAcceptedAt !== undefined ? { receivedAt: s.lastAcceptedAt } : {}),
    ts: s.lastTs,
  });

  return {
    /** Live flights, optionally clipped to a viewport bbox. */
    async live(bbox?: Bbox): Promise<LiveFlight[]> {
      const ids = await redis.smembers(activeKey);
      if (ids.length === 0) return [];
      const raws = await redis.mget(ids.map(stateKey));
      const out: LiveFlight[] = [];
      for (const raw of raws) {
        if (!raw) continue;
        let parsed: z.SafeParseReturnType<unknown, z.infer<typeof hotStateSchema>>;
        try {
          parsed = hotStateSchema.safeParse(JSON.parse(raw));
        } catch {
          continue;
        }
        if (!parsed.success) continue;
        if (bbox && !inBbox(parsed.data.lat, parsed.data.lon, bbox)) continue;
        out.push(toLive(parsed.data));
      }
      return out;
    },

    /** Latest hot state for one active flight, if it is still in Redis. */
    async get(flightId: string): Promise<LiveFlight | null> {
      const raw = await redis.get(stateKey(flightId));
      if (!raw) return null;
      let parsed: z.SafeParseReturnType<unknown, z.infer<typeof hotStateSchema>>;
      try {
        parsed = hotStateSchema.safeParse(JSON.parse(raw));
      } catch {
        return null;
      }
      return parsed.success ? toLive(parsed.data) : null;
    },

    /** Count of currently-active flights (landing-page counter). */
    async count(): Promise<number> {
      return redis.scard(activeKey);
    },
  };
}

export type HotState = ReturnType<typeof createHotState>;
