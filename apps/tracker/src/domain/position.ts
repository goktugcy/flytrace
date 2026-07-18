import { z } from 'zod';

/**
 * A normalized position sample — the tracker's canonical unit, independent of
 * the source. Units are aviation-standard (ft / kt / fpm) and timestamps are
 * UTC ISO. Unknown source fields are preserved as `null`, never fabricated
 * (docs/08 §8.3).
 */
export interface Position {
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  headingDeg: number | null;
  gsKt: number | null;
  vrateFpm: number | null;
  onGround: boolean;
  /** Event time (UTC ISO) — when the source observed this sample. */
  ts: string;
}

// ── Unit conversions ──
const M_TO_FT = 3.280_839_895;
const MS_TO_KT = 1.943_844_492;
const MS_TO_FPM = 196.850_393_701;

const round = (n: number, dp = 2): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * OpenSky `/states/all` state vector — a positional array (see docs/08 §8.3).
 * Only the fields the tracker consumes are typed; the rest are tolerated.
 */
export const openSkyStateVectorSchema = z
  .tuple([
    z.string(), // 0 icao24
    z
      .string()
      .nullable(), // 1 callsign
    z.string(), // 2 origin_country
    z
      .number()
      .nullable(), // 3 time_position (unix s)
    z.number(), // 4 last_contact (unix s)
    z
      .number()
      .nullable(), // 5 longitude
    z
      .number()
      .nullable(), // 6 latitude
    z
      .number()
      .nullable(), // 7 baro_altitude (m)
    z.boolean(), // 8 on_ground
    z
      .number()
      .nullable(), // 9 velocity (m/s)
    z
      .number()
      .nullable(), // 10 true_track (deg)
    z
      .number()
      .nullable(), // 11 vertical_rate (m/s)
  ])
  // OpenSky appends more fields (sensors, geo_altitude, squawk, spi,
  // position_source, category…) — tolerate any trailing elements so the
  // fixed-arity tuple doesn't reject real 17+-element vectors.
  .rest(z.unknown());
export type OpenSkyStateVector = z.infer<typeof openSkyStateVectorSchema>;

export const openSkyStatesResponseSchema = z.object({
  time: z.number(),
  states: z.array(z.array(z.unknown())).nullable(),
});
export type OpenSkyStatesResponse = z.infer<typeof openSkyStatesResponseSchema>;

/**
 * Normalize one OpenSky state vector into a {@link Position}.
 * Returns `null` when the sample cannot be placed (missing lat/lon) — such
 * samples are useless for tracking and must not be fabricated.
 */
export function normalizeStateVector(raw: unknown): Position | null {
  const parsed = openSkyStateVectorSchema.safeParse(raw);
  if (!parsed.success) return null;
  const [
    icao24,
    callsign,
    ,
    timePosition,
    lastContact,
    lon,
    lat,
    baroAltM,
    onGround,
    velMs,
    track,
    vrateMs,
  ] = parsed.data;

  if (lat === null || lon === null) return null;

  const tsSec = timePosition ?? lastContact;
  return {
    icao24: icao24.toLowerCase(),
    callsign: callsign ? callsign.trim() || null : null,
    lat,
    lon,
    altFt: baroAltM === null ? null : round(baroAltM * M_TO_FT, 0),
    headingDeg: track,
    gsKt: velMs === null ? null : round(velMs * MS_TO_KT, 1),
    vrateFpm: vrateMs === null ? null : round(vrateMs * MS_TO_FPM, 0),
    onGround,
    ts: new Date(tsSec * 1000).toISOString(),
  };
}

/** Normalize a full `/states/all` response into placed positions. */
export function normalizeStatesResponse(raw: unknown): Position[] {
  const parsed = openSkyStatesResponseSchema.safeParse(raw);
  if (!parsed.success || parsed.data.states === null) return [];
  const out: Position[] = [];
  for (const sv of parsed.data.states) {
    const pos = normalizeStateVector(sv);
    if (pos !== null) out.push(pos);
  }
  return out;
}
