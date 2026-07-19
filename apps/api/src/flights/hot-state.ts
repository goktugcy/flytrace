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
    headingDeg: z.number().nullable(),
    gsKt: z.number().nullable(),
    airborne: z.boolean(),
    lastTs: z.string(),
    qualityState: flightQualityStateSchema.optional(),
    lastAcceptedAt: z.string().optional(),
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
    headingDeg: s.headingDeg,
    groundSpeedKt: s.gsKt,
    onGround: !s.airborne,
    ...(s.qualityState !== undefined ? { qualityState: s.qualityState } : {}),
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

    /** Count of currently-active flights (landing-page counter). */
    async count(): Promise<number> {
      return redis.scard(activeKey);
    },
  };
}

export type HotState = ReturnType<typeof createHotState>;
