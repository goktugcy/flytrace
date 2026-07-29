import { type Logger, configSchemas, createLogger, loadConfig } from '@flytrace/shared';
/**
 * Airport ground-geometry import from OpenStreetMap (Overpass API). Fetches
 * aeroway=* features around each configured airport and upserts them into
 * `airport_geometries` (idempotent per airport+source). Free/open data only.
 *
 * The parser (`parseOverpassAeroway`) is pure so it can be unit-tested against
 * a fixture without hitting the network.
 */
import { sql } from 'drizzle-orm';
import { type Database, createDb } from './index.ts';

export type AeroFeatureKind =
  | 'runway'
  | 'taxiway'
  | 'apron'
  | 'terminal'
  | 'gate'
  | 'hangar'
  | 'parking';

/** OSM `aeroway` tag → our feature kind. Unlisted values are ignored. */
const AEROWAY_KIND: Record<string, AeroFeatureKind> = {
  runway: 'runway',
  taxiway: 'taxiway',
  apron: 'apron',
  terminal: 'terminal',
  gate: 'gate',
  hangar: 'hangar',
  parking_position: 'parking',
};

/** Kinds stored as polygons (areas); everything else that is a way → line. */
const AREA_KINDS = new Set<AeroFeatureKind>(['apron', 'terminal', 'hangar', 'parking']);

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}

export interface ParsedAirportFeature {
  kind: AeroFeatureKind;
  ref: string | null;
  name: string | null;
  osmId: string;
  /** EWKT geometry, SRID 4326. */
  ewkt: string;
}

function coordList(geometry: { lat: number; lon: number }[]): string {
  return geometry.map((g) => `${g.lon} ${g.lat}`).join(', ');
}

/** Pure Overpass → feature parser. Skips elements without usable geometry. */
export function parseOverpassAeroway(elements: OverpassElement[]): ParsedAirportFeature[] {
  const out: ParsedAirportFeature[] = [];
  for (const el of elements) {
    const aeroway = el.tags?.aeroway;
    const kind = aeroway ? AEROWAY_KIND[aeroway] : undefined;
    if (!kind) continue;
    const ref = el.tags?.ref ?? el.tags?.local_ref ?? null;
    const name = el.tags?.name ?? null;
    const osmId = `${el.type}/${el.id}`;

    if (el.type === 'node') {
      if (typeof el.lat !== 'number' || typeof el.lon !== 'number') continue;
      out.push({ kind, ref, name, osmId, ewkt: `SRID=4326;POINT(${el.lon} ${el.lat})` });
      continue;
    }
    const geom = el.geometry;
    if (!geom || geom.length < 2) continue;
    if (AREA_KINDS.has(kind)) {
      // Close the ring for a polygon.
      const first = geom[0];
      const last = geom[geom.length - 1];
      const ring =
        first && last && (first.lat !== last.lat || first.lon !== last.lon)
          ? [...geom, first]
          : geom;
      if (ring.length < 4) continue; // need ≥3 distinct points + closure
      out.push({ kind, ref, name, osmId, ewkt: `SRID=4326;POLYGON((${coordList(ring)}))` });
    } else {
      out.push({ kind, ref, name, osmId, ewkt: `SRID=4326;LINESTRING(${coordList(geom)})` });
    }
  }
  return out;
}

/** Overpass QL for every aeroway feature within `radiusM` of the airport. */
export function buildOverpassQuery(lat: number, lon: number, radiusM: number): string {
  const around = `(around:${Math.round(radiusM)},${lat},${lon})`;
  return `[out:json][timeout:90];
(
  way["aeroway"]${around};
  node["aeroway"="gate"]${around};
  node["aeroway"="parking_position"]${around};
);
out geom;`;
}

type Fetcher = typeof fetch;

/**
 * Public Overpass mirrors, tried in order. The main instance is frequently
 * overloaded (504/429), so we fall back to community mirrors before giving up.
 */
const DEFAULT_OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOverpass(
  urls: string | string[],
  query: string,
  fetchImpl: Fetcher,
  logger?: Logger,
): Promise<OverpassElement[]> {
  const mirrors = Array.isArray(urls) ? urls : [urls];
  let lastErr: unknown;
  for (let i = 0; i < mirrors.length; i++) {
    const url = mirrors[i] as string;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'FlyTrace/1.0',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`Overpass request failed (${res.status})`);
      const body = (await res.json()) as { elements?: OverpassElement[] };
      return body.elements ?? [];
    } catch (err) {
      lastErr = err;
      logger?.warn('airport-osm: overpass mirror failed', { url, error: String(err) });
      if (i < mirrors.length - 1) await sleep(2000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass: all mirrors failed');
}

export interface ImportAirportOsmOptions {
  airportId: string;
  lat: number;
  lon: number;
  radiusM: number;
  overpassUrl: string | string[];
  datasetVersion: string;
  fetchImpl?: Fetcher;
  logger?: Logger;
}

/** Fetch + upsert one airport's ground geometry. Returns the feature count. */
export async function importAirportOsm(
  db: Database,
  opts: ImportAirportOsmOptions,
): Promise<{ upserted: number }> {
  const elements = await fetchOverpass(
    opts.overpassUrl,
    buildOverpassQuery(opts.lat, opts.lon, opts.radiusM),
    opts.fetchImpl ?? fetch,
    opts.logger,
  );
  const features = parseOverpassAeroway(elements);
  await upsertAirportGeometries(db, opts.airportId, features, {
    source: 'osm',
    datasetVersion: opts.datasetVersion,
  });
  opts.logger?.info('airport-osm: imported', {
    airportId: opts.airportId,
    features: features.length,
  });
  return { upserted: features.length };
}

/** Replace an airport's geometries for a source in one transaction (idempotent). */
export async function upsertAirportGeometries(
  db: Database,
  airportId: string,
  features: ParsedAirportFeature[],
  opts: { source: string; datasetVersion: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from airport_geometries where airport_id = ${airportId} and source = ${opts.source}`,
    );
    for (const f of features) {
      await tx.execute(sql`
        insert into airport_geometries (airport_id, kind, ref, name, geom, source, dataset_version, osm_id)
        values (${airportId}, ${f.kind}, ${f.ref}, ${f.name},
                ST_GeomFromEWKT(${f.ewkt}), ${opts.source}, ${opts.datasetVersion}, ${f.osmId})`);
    }
  });
}

async function main(): Promise<void> {
  // Base + database come from the validated schema; the OSM-import knobs are
  // read straight from env (keeps zod out of @flytrace/db — no new dependency).
  const config = loadConfig(configSchemas.base.merge(configSchemas.database));
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'airport-osm-import', env: config.APP_ENV },
  });
  // Honour an explicit override, otherwise rotate through the public mirrors.
  const overpassUrl = process.env.OSM_OVERPASS_URL
    ? process.env.OSM_OVERPASS_URL.split(',').map((s) => s.trim())
    : DEFAULT_OVERPASS_MIRRORS;
  const radiusM = Number(process.env.AIRPORT_OSM_RADIUS_M) || 6000;
  const datasetVersion = process.env.AIRPORT_OSM_DATASET_VERSION ?? 'osm-local';
  const delayMs = Number(process.env.AIRPORT_OSM_DELAY_MS) || 2000;
  const { db, close } = createDb({ url: config.DATABASE_URL, max: 1 });
  try {
    const targets = await resolveTargets(db, logger);
    logger.info('airport-osm: targets resolved', { count: targets.length });
    let done = 0;
    let failed = 0;
    // Retry each airport a few times with growing backoff — Overpass mirrors
    // rate-limit sustained batch traffic (504/429), so a short wait usually
    // clears the window instead of skipping the airport.
    const maxAttempts = Math.max(1, Number(process.env.AIRPORT_OSM_RETRIES) || 3);
    for (const airport of targets) {
      let ok = false;
      for (let attempt = 1; attempt <= maxAttempts && !ok; attempt += 1) {
        try {
          const { upserted } = await importAirportOsm(db, {
            airportId: airport.id,
            lat: airport.lat,
            lon: airport.lon,
            radiusM,
            overpassUrl,
            datasetVersion,
            logger,
          });
          done += 1;
          ok = true;
          logger.info('airport-osm: airport done', {
            icao: airport.icao,
            upserted,
            progress: `${done + failed}/${targets.length}`,
          });
        } catch (err) {
          if (attempt < maxAttempts) {
            const backoff = 6000 * attempt; // 6s, 12s, …
            logger.warn('airport-osm: airport attempt failed, backing off', {
              icao: airport.icao,
              attempt,
              backoffMs: backoff,
              error: String(err),
            });
            await sleep(backoff);
          } else {
            failed += 1;
            logger.error('airport-osm: airport failed after retries, skipping', {
              icao: airport.icao,
              error: String(err),
            });
          }
        }
      }
      if (targets.length > 1) await sleep(delayMs); // be gentle with the shared mirrors
    }
    logger.info('airport-osm: complete', { done, failed, total: targets.length });
  } finally {
    await close();
  }
}

interface ImportTarget {
  id: string;
  icao: string;
  lat: number;
  lon: number;
}

/**
 * Which airports to import. Default: the explicit AIRPORT_OSM_ICAOS list.
 * Bulk mode (AIRPORT_OSM_ALL=true): every airport of the configured types
 * (default large + medium) that has a location and NO geometry yet — so the
 * job is resumable and can be run repeatedly to fill coverage. Optional filters:
 * AIRPORT_OSM_TYPES, AIRPORT_OSM_COUNTRY (ISO), AIRPORT_OSM_LIMIT (per run).
 */
async function resolveTargets(db: Database, logger: Logger): Promise<ImportTarget[]> {
  const usable = (
    rows: { id: string; icao: string | null; lat: number | null; lon: number | null }[],
  ) =>
    rows.filter(
      (r): r is ImportTarget => Boolean(r.id && r.icao) && r.lat != null && r.lon != null,
    );

  if (process.env.AIRPORT_OSM_ALL === 'true') {
    const types = (process.env.AIRPORT_OSM_TYPES ?? 'large_airport,medium_airport')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = Math.max(1, Number(process.env.AIRPORT_OSM_LIMIT) || 1000);
    const country = process.env.AIRPORT_OSM_COUNTRY?.trim().toUpperCase();
    const rows = (await db.execute(sql`
      select a.id, a.icao,
             ST_Y(a.location::geometry) as lat, ST_X(a.location::geometry) as lon
      from airports a
      left join (select distinct airport_id from airport_geometries) g on g.airport_id = a.id
      where a.location is not null
        and a.icao is not null
        and g.airport_id is null
        and a.type in (${sql.join(
          types.map((t) => sql`${t}`),
          sql`, `,
        )})
        ${country ? sql`and a.country = ${country}` : sql``}
      order by case a.type when 'large_airport' then 1 when 'medium_airport' then 2 else 3 end,
               a.scheduled_service desc nulls last
      limit ${limit}
    `)) as unknown as { id: string; icao: string | null; lat: number | null; lon: number | null }[];
    return usable(rows);
  }

  // Explicit ICAO list (default).
  const icaos = (process.env.AIRPORT_OSM_ICAOS ?? 'LTFM,LTFJ,LTAC')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const out: ImportTarget[] = [];
  for (const icao of icaos) {
    const rows = (await db.execute(sql`
      select id, icao, ST_Y(location::geometry) as lat, ST_X(location::geometry) as lon
      from airports where icao = ${icao} limit 1
    `)) as unknown as { id: string; icao: string | null; lat: number | null; lon: number | null }[];
    const [t] = usable(rows);
    if (t) out.push(t);
    else logger.warn('airport-osm: airport not found or has no location', { icao });
  }
  return out;
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
