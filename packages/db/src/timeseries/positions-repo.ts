import { selectAdapter } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../index.ts';
import type { PositionRow } from '../repos/flights-read.ts';
import { ewktPoint } from '../schema/_custom.ts';

/**
 * Timeseries storage for flight positions (docs/11 §11.6 track/history reads +
 * high-volume ingest). Two interchangeable backends sit behind one interface:
 *
 *  - `PgPositionRepo`      — plain Postgres over `flight_positions`, projecting
 *                            lat/lon out of the PostGIS geography with ST_X/ST_Y
 *                            (same style as repos/flights-read.ts). The default;
 *                            works with a stock Postgres + PostGIS install.
 *  - `TimescalePositionRepo` — wraps the Pg repo and overrides the *history*
 *                            reads with `time_bucket` aggregation, so long, dense
 *                            tracks come back downsampled straight from the DB.
 *
 * The factory chooses a backend from config via `selectAdapter`, defaulting to
 * `postgres` so the module runs against any Postgres with zero extensions.
 */

/** A single altitude sample (or bucket average) on the flight's timeline. */
export interface AltitudePoint {
  ts: string;
  altitudeFt: number | null;
}

/** A single ground-speed sample (or bucket average) on the flight's timeline. */
export interface SpeedPoint {
  ts: string;
  groundSpeedKt: number | null;
}

/** Row accepted by `insertBatch` — mirrors the writer's PositionInput shape. */
export interface TimeseriesPositionInput {
  flightId: string;
  ts: Date;
  icao24: string | null;
  lon: number;
  lat: number;
  altitudeFt: number | null;
  geoAltitudeFt?: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  squawk?: string | null;
  source: string;
}

/** Storage-agnostic contract every backend implements. */
export interface PositionTimeseriesRepo {
  /** Newest known position for a flight, or null if untracked. */
  lastPosition(flightId: string): Promise<PositionRow | null>;
  /** Oldest→newest track, capped at `limit` points. */
  trail(flightId: string, limit: number): Promise<PositionRow[]>;
  /** Altitude over time (possibly bucket-aggregated), oldest→newest. */
  altitudeHistory(flightId: string): Promise<AltitudePoint[]>;
  /** Ground speed over time (possibly bucket-aggregated), oldest→newest. */
  speedHistory(flightId: string): Promise<SpeedPoint[]>;
  /** Idempotent batch insert; (flight_id, ts) conflicts are dropped. */
  insertBatch(rows: TimeseriesPositionInput[]): Promise<number>;
}

/** Minimal DB surface these repos need — lets tests inject a fake `execute`. */
export interface ExecutableDb {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Plain-Postgres backend. Every read projects the geography to a geometry and
 * pulls lat/lon with ST_Y/ST_X, exactly like repos/flights-read.ts.
 */
export class PgPositionRepo implements PositionTimeseriesRepo {
  constructor(protected readonly db: ExecutableDb) {}

  async lastPosition(flightId: string): Promise<PositionRow | null> {
    const rows = (await this.db.execute(sql`
      select ts,
             ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon,
             altitude_ft as "altitudeFt", geo_altitude_ft as "geoAltitudeFt",
             heading_deg as "headingDeg",
             ground_speed_kt as "groundSpeedKt", vertical_rate_fpm as "verticalRateFpm",
             on_ground as "onGround", squawk, source
      from flight_positions
      where flight_id = ${flightId}
      order by ts desc
      limit 1
    `)) as unknown as PositionRow[];
    return rows[0] ?? null;
  }

  async trail(flightId: string, limit: number): Promise<PositionRow[]> {
    return (await this.db.execute(sql`
      select ts,
             ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon,
             altitude_ft as "altitudeFt", geo_altitude_ft as "geoAltitudeFt",
             heading_deg as "headingDeg",
             ground_speed_kt as "groundSpeedKt", vertical_rate_fpm as "verticalRateFpm",
             on_ground as "onGround", squawk, source
      from flight_positions
      where flight_id = ${flightId}
      order by ts asc
      limit ${limit}
    `)) as unknown as PositionRow[];
  }

  async altitudeHistory(flightId: string): Promise<AltitudePoint[]> {
    return (await this.db.execute(sql`
      select ts, altitude_ft as "altitudeFt"
      from flight_positions
      where flight_id = ${flightId}
      order by ts asc
    `)) as unknown as AltitudePoint[];
  }

  async speedHistory(flightId: string): Promise<SpeedPoint[]> {
    return (await this.db.execute(sql`
      select ts, ground_speed_kt as "groundSpeedKt"
      from flight_positions
      where flight_id = ${flightId}
      order by ts asc
    `)) as unknown as SpeedPoint[];
  }

  async insertBatch(rows: TimeseriesPositionInput[]): Promise<number> {
    if (rows.length === 0) return 0;
    const tuples = rows.map(
      (r) => sql`(
        ${r.flightId}, ${r.ts}, ${r.icao24},
        ${ewktPoint(r.lon, r.lat)}::geography,
        ${r.altitudeFt}, ${r.geoAltitudeFt ?? null}, ${r.headingDeg},
        ${r.groundSpeedKt}, ${r.verticalRateFpm}, ${r.onGround},
        ${r.squawk ?? null}, ${r.source}
      )`,
    );
    await this.db.execute(sql`
      insert into flight_positions
        (flight_id, ts, icao24, location, altitude_ft, geo_altitude_ft,
         heading_deg, ground_speed_kt, vertical_rate_fpm, on_ground, squawk, source)
      values ${sql.join(tuples, sql`, `)}
      on conflict (flight_id, ts) do nothing
    `);
    return rows.length;
  }
}

/**
 * TimescaleDB backend. Track reads are identical to Postgres, so it delegates
 * `lastPosition`/`trail`/`insertBatch` to an embedded `PgPositionRepo` and only
 * overrides the histories with `time_bucket` aggregation — dense tracks come
 * back pre-downsampled without shipping every raw sample over the wire.
 */
export class TimescalePositionRepo implements PositionTimeseriesRepo {
  private readonly pg: PgPositionRepo;

  /** @param bucket time_bucket interval literal (e.g. '1 minute'). */
  constructor(
    protected readonly db: ExecutableDb,
    private readonly bucket = '1 minute',
  ) {
    this.pg = new PgPositionRepo(db);
  }

  lastPosition(flightId: string): Promise<PositionRow | null> {
    return this.pg.lastPosition(flightId);
  }

  trail(flightId: string, limit: number): Promise<PositionRow[]> {
    return this.pg.trail(flightId, limit);
  }

  insertBatch(rows: TimeseriesPositionInput[]): Promise<number> {
    return this.pg.insertBatch(rows);
  }

  async altitudeHistory(flightId: string): Promise<AltitudePoint[]> {
    return (await this.db.execute(sql`
      select time_bucket(${this.bucket}::interval, ts) as ts,
             round(avg(altitude_ft))::int as "altitudeFt"
      from flight_positions
      where flight_id = ${flightId}
      group by 1
      order by 1 asc
    `)) as unknown as AltitudePoint[];
  }

  async speedHistory(flightId: string): Promise<SpeedPoint[]> {
    return (await this.db.execute(sql`
      select time_bucket(${this.bucket}::interval, ts) as ts,
             avg(ground_speed_kt) as "groundSpeedKt"
      from flight_positions
      where flight_id = ${flightId}
      group by 1
      order by 1 asc
    `)) as unknown as SpeedPoint[];
  }
}

export type TimeseriesBackend = 'postgres' | 'timescale';

export interface CreatePositionRepoOptions {
  /** Config value (TIMESERIES_BACKEND); unknown values fall back to postgres. */
  backend?: string;
  /** time_bucket interval for the timescale backend (default '1 minute'). */
  bucket?: string;
  logger?: {
    warn: (msg: string, meta?: unknown) => void;
    info?: (msg: string, meta?: unknown) => void;
  };
}

/**
 * Build a `PositionTimeseriesRepo` for the configured backend. Uses the shared
 * `selectAdapter` convention: an unknown/absent backend degrades to `postgres`
 * (the always-present local fallback), so the module boots with zero setup.
 */
export function createPositionTimeseriesRepo(
  db: Database,
  opts: CreatePositionRepoOptions = {},
): Promise<PositionTimeseriesRepo> {
  return selectAdapter<PositionTimeseriesRepo>({
    label: 'timeseries',
    kind: opts.backend,
    fallback: 'postgres',
    adapters: {
      postgres: () => new PgPositionRepo(db as unknown as ExecutableDb),
      timescale: () => new TimescalePositionRepo(db as unknown as ExecutableDb, opts.bucket),
    },
    ...(opts.logger ? { logger: opts.logger } : {}),
  });
}
