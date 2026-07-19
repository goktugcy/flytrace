import { sql } from 'drizzle-orm';
import { createDb } from './index.ts';
import { ewktPoint } from './schema/_custom.ts';

const AIRPORTS_URL =
  process.env.AIRPORTS_CSV_URL ?? 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const RUNWAYS_URL =
  process.env.RUNWAYS_CSV_URL ?? 'https://davidmegginson.github.io/ourairports-data/runways.csv';
const CHUNK_SIZE = Math.max(50, Math.min(Number(process.env.AIRPORT_IMPORT_CHUNK ?? 500), 1000));

interface AirportImportRow {
  iata: string | null;
  icao: string;
  name: string;
  type: string | null;
  city: string | null;
  country: string | null;
  lat: number;
  lon: number;
  elevationFt: number | null;
  runways: RunwayImportRow[];
  scheduledService: boolean;
  homeUrl: string | null;
  wikipediaUrl: string | null;
  keywords: string | null;
}

interface RunwayImportRow {
  lengthFt: number | null;
  widthFt: number | null;
  surface: string | null;
  lighted: boolean;
  closed: boolean;
  leIdent: string | null;
  heIdent: string | null;
}

const TYPE_RANK: Record<string, number> = {
  large_airport: 7,
  medium_airport: 6,
  small_airport: 5,
  heliport: 4,
  seaplane_base: 3,
  balloonport: 2,
  closed: 1,
};

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to import airports');
  const { db, close } = createDb({ url, max: 1 });

  try {
    console.log(`[airports] downloading ${AIRPORTS_URL}`);
    const airportsCsv = await downloadText(AIRPORTS_URL);
    console.log(`[airports] downloading ${RUNWAYS_URL}`);
    const runwaysCsv = await downloadText(RUNWAYS_URL);

    const runwaysByAirport = parseRunways(runwaysCsv);
    const rows = parseAirports(airportsCsv, runwaysByAirport);
    console.log(`[airports] parsed ${rows.length.toLocaleString()} airport rows`);

    let imported = 0;
    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      await upsertAirports(db, chunk);
      imported += chunk.length;
      if (imported % (CHUNK_SIZE * 10) === 0 || imported === rows.length) {
        console.log(
          `[airports] imported ${imported.toLocaleString()}/${rows.length.toLocaleString()}`,
        );
      }
    }

    await db.execute(sql`analyze airports`);
    console.log('[airports] done');
  } finally {
    await close();
  }
}

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`);
  return res.text();
}

function parseAirports(
  csv: string,
  runwaysByAirport: Map<string, RunwayImportRow[]>,
): AirportImportRow[] {
  const rows = csvRecords(csv);
  const prepared = rows
    .map((r) => {
      const lat = numberOrNull(r.latitude_deg);
      const lon = numberOrNull(r.longitude_deg);
      const icao = cleanCode(r.ident);
      const name = clean(r.name);
      if (!icao || !name || lat === null || lon === null) return null;
      const iata = cleanIata(r.iata_code);
      return {
        rawIata: iata,
        row: {
          iata,
          icao,
          name,
          type: clean(r.type),
          city: clean(r.municipality),
          country: clean(r.iso_country),
          lat,
          lon,
          elevationFt: intOrNull(r.elevation_ft),
          runways: runwaysByAirport.get(icao) ?? [],
          scheduledService: r.scheduled_service === 'yes',
          homeUrl: cleanUrl(r.home_link),
          wikipediaUrl: cleanUrl(r.wikipedia_link),
          keywords: clean(r.keywords),
        } satisfies AirportImportRow,
      };
    })
    .filter((r): r is { rawIata: string | null; row: AirportImportRow } => r !== null);

  const keeperByIata = new Map<string, AirportImportRow>();
  for (const item of prepared) {
    if (!item.rawIata) continue;
    const current = keeperByIata.get(item.rawIata);
    if (!current || airportRank(item.row) > airportRank(current))
      keeperByIata.set(item.rawIata, item.row);
  }

  return prepared.map((item) => ({
    ...item.row,
    iata: item.rawIata && keeperByIata.get(item.rawIata) === item.row ? item.rawIata : null,
  }));
}

function parseRunways(csv: string): Map<string, RunwayImportRow[]> {
  const out = new Map<string, RunwayImportRow[]>();
  for (const r of csvRecords(csv)) {
    const airport = cleanCode(r.airport_ident);
    if (!airport) continue;
    const row: RunwayImportRow = {
      lengthFt: intOrNull(r.length_ft),
      widthFt: intOrNull(r.width_ft),
      surface: clean(r.surface),
      lighted: r.lighted === '1',
      closed: r.closed === '1',
      leIdent: clean(r.le_ident),
      heIdent: clean(r.he_ident),
    };
    const list = out.get(airport);
    if (list) list.push(row);
    else out.set(airport, [row]);
  }
  return out;
}

async function upsertAirports(db: ReturnType<typeof createDb>['db'], rows: AirportImportRow[]) {
  if (rows.length === 0) return;
  const tuples = rows.map((r) => {
    const runways = JSON.stringify(r.runways);
    return sql`(
      ${r.iata}, ${r.icao}, ${r.name}, ${r.type}, ${r.city}, ${r.country},
      ${ewktPoint(r.lon, r.lat)}::geography, ${r.elevationFt}, ${runways}::jsonb,
      ${r.scheduledService}, ${r.homeUrl}, ${r.wikipediaUrl}, ${r.keywords}
    )`;
  });
  await db.execute(sql`
    insert into airports
      (iata, icao, name, type, city, country, location, elevation_ft, runways,
       scheduled_service, home_url, wikipedia_url, keywords)
    values ${sql.join(tuples, sql`, `)}
    on conflict (icao) do update set
      iata = excluded.iata,
      name = excluded.name,
      type = excluded.type,
      city = excluded.city,
      country = excluded.country,
      location = excluded.location,
      elevation_ft = excluded.elevation_ft,
      runways = excluded.runways,
      scheduled_service = excluded.scheduled_service,
      home_url = excluded.home_url,
      wikipedia_url = excluded.wikipedia_url,
      keywords = excluded.keywords,
      updated_at = now()
  `);
}

function airportRank(row: AirportImportRow): number {
  return (
    (row.scheduledService ? 100 : 0) +
    (TYPE_RANK[row.type ?? ''] ?? 0) * 10 +
    Math.min(row.runways.length, 9)
  );
}

function csvRecords(csv: string): Record<string, string>[] {
  const rows = parseCsv(csv);
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((row) => row.length > 1)
    .map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}

function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function clean(value: string | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

function cleanCode(value: string | undefined): string | null {
  const v = clean(value)?.toUpperCase();
  return v ?? null;
}

function cleanIata(value: string | undefined): string | null {
  const v = cleanCode(value);
  return v && /^[A-Z0-9]{3}$/.test(v) ? v : null;
}

function cleanUrl(value: string | undefined): string | null {
  const v = clean(value);
  if (!v || !/^https?:\/\//i.test(v)) return null;
  return v;
}

function numberOrNull(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function intOrNull(value: string | undefined): number | null {
  const n = numberOrNull(value);
  return n === null ? null : Math.round(n);
}

main().catch((err) => {
  console.error('[airports] failed', err);
  process.exit(1);
});
