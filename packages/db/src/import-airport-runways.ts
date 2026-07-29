import { type Logger, configSchemas, createLogger, loadConfig } from '@flytrace/shared';
/**
 * Bulk runway-geometry import from the OurAirports `runways.csv` dataset
 * (public domain). One download gives every airport's runway centrelines — far
 * faster than querying Overpass per airport. Each runway becomes a LINESTRING
 * from its low-end (le) to high-end (he) threshold. Stored with source
 * `ourairports`; airports that already have detailed OSM geometry are skipped so
 * the two sources never draw duplicate runways.
 *
 * `parseRunwaysCsv` is pure (network-free) so it can be unit-tested.
 */
import { sql } from 'drizzle-orm';
import { type Database, createDb } from './index.ts';

const RUNWAYS_CSV_URL = 'https://davidmegginson.github.io/ourairports-data/runways.csv';

export interface CsvRunway {
  icao: string;
  ref: string;
  leLat: number;
  leLon: number;
  heLat: number;
  heLon: number;
}

/** Split one CSV line, honouring double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Parse OurAirports runways.csv into usable runway centrelines. Skips closed
 * runways and any row missing an ICAO or a valid pair of threshold coordinates.
 */
export function parseRunwaysCsv(text: string): CsvRunway[] {
  const lines = text.split(/\r?\n/);
  const header = splitCsvLine(lines[0] ?? '');
  const col = (name: string) => header.indexOf(name);
  const ci = {
    icao: col('airport_ident'),
    closed: col('closed'),
    leIdent: col('le_ident'),
    leLat: col('le_latitude_deg'),
    leLon: col('le_longitude_deg'),
    heIdent: col('he_ident'),
    heLat: col('he_latitude_deg'),
    heLon: col('he_longitude_deg'),
  };
  const num = (v: string | undefined): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out: CsvRunway[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const f = splitCsvLine(line);
    if (f[ci.closed] === '1') continue;
    const icao = (f[ci.icao] ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) continue;
    const leLat = num(f[ci.leLat]);
    const leLon = num(f[ci.leLon]);
    const heLat = num(f[ci.heLat]);
    const heLon = num(f[ci.heLon]);
    if (leLat == null || leLon == null || heLat == null || heLon == null) continue;
    const leId = (f[ci.leIdent] ?? '').trim();
    const heId = (f[ci.heIdent] ?? '').trim();
    out.push({
      icao,
      ref: [leId, heId].filter(Boolean).join('/') || 'RWY',
      leLat,
      leLon,
      heLat,
      heLon,
    });
  }
  return out;
}

export interface RunwayImportResult {
  airports: number;
  runways: number;
}

/**
 * Download + import all OurAirports runways as `source='ourairports'` runway
 * lines. Full refresh: wipes existing ourairports rows first (idempotent).
 * Airports with OSM geometry are skipped (OSM supersedes). Batched inserts keep
 * it fast enough to run inline from an admin request.
 */
export async function importRunwaysFromCsv(
  db: Database,
  opts: {
    csvUrl?: string;
    datasetVersion?: string;
    fetchImpl?: typeof fetch;
    logger?: Logger;
  } = {},
): Promise<RunwayImportResult> {
  const url = opts.csvUrl ?? RUNWAYS_CSV_URL;
  const datasetVersion = opts.datasetVersion ?? 'ourairports';
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { 'user-agent': 'FlyTrace/1.0' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`runways.csv download failed (${res.status})`);
  const runways = parseRunwaysCsv(await res.text());
  opts.logger?.info('airport-runways: parsed', { runways: runways.length });

  // Map ICAO → airport id, but only for airports WITHOUT OSM geometry (OSM wins).
  const rows = (await db.execute(sql`
    select a.id, a.icao
    from airports a
    left join (select distinct airport_id from airport_geometries where source = 'osm') o
      on o.airport_id = a.id
    where a.icao is not null and o.airport_id is null
  `)) as unknown as { id: string; icao: string }[];
  const idByIcao = new Map(rows.map((r) => [r.icao.toUpperCase(), r.id]));

  interface Row {
    airportId: string;
    ref: string;
    ewkt: string;
  }
  const insertRows: Row[] = [];
  const airports = new Set<string>();
  for (const r of runways) {
    const airportId = idByIcao.get(r.icao);
    if (!airportId) continue; // unknown airport or has OSM geometry
    insertRows.push({
      airportId,
      ref: r.ref,
      ewkt: `SRID=4326;LINESTRING(${r.leLon} ${r.leLat}, ${r.heLon} ${r.heLat})`,
    });
    airports.add(airportId);
  }

  await db.execute(sql`delete from airport_geometries where source = 'ourairports'`);
  const BATCH = 500;
  for (let i = 0; i < insertRows.length; i += BATCH) {
    const batch = insertRows.slice(i, i + BATCH);
    const values = batch.map(
      (r) =>
        sql`(${r.airportId}, 'runway', ${r.ref}, ${r.ref}, ST_GeomFromEWKT(${r.ewkt}), 'ourairports', ${datasetVersion}, ${null})`,
    );
    await db.execute(sql`
      insert into airport_geometries
        (airport_id, kind, ref, name, geom, source, dataset_version, osm_id)
      values ${sql.join(values, sql`, `)}
    `);
  }
  opts.logger?.info('airport-runways: imported', {
    airports: airports.size,
    runways: insertRows.length,
  });
  return { airports: airports.size, runways: insertRows.length };
}

async function main(): Promise<void> {
  const config = loadConfig(configSchemas.base.merge(configSchemas.database));
  const logger = createLogger({
    level: config.LOG_LEVEL,
    base: { app: 'airport-runways-import', env: config.APP_ENV },
  });
  const { db, close } = createDb({ url: config.DATABASE_URL, max: 1 });
  try {
    const result = await importRunwaysFromCsv(db, { logger });
    logger.info('airport-runways: complete', { ...result });
  } finally {
    await close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
