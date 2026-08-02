import { loadRootEnv } from '@flytrace/shared';
import { sql } from 'drizzle-orm';
import { createDb } from './index.ts';

/**
 * Global airline catalog import from OpenFlights.
 *
 * Source: https://openflights.org/data.php
 * Direct data: https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat
 * License: Open Database License (ODbL). Keep attribution in user-facing docs/deploy notes.
 */
const AIRLINES_URL =
  process.env.AIRLINES_DAT_URL ??
  'https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat';
const CHUNK_SIZE = Math.max(50, Math.min(Number(process.env.AIRLINE_IMPORT_CHUNK ?? 500), 1000));

interface AirlineImportRow {
  iata: string | null;
  icao: string | null;
  name: string;
  callsign: string | null;
  country: string | null;
  active: boolean;
}

interface ExistingAirlineCode {
  iata: string | null;
  icao: string | null;
}

async function main() {
  // Fill process.env from the single root .env, like loadConfig() does for the
  // scripts that use it — so the documented `bun run` command works from a
  // fresh checkout. Real environment variables always win.
  loadRootEnv();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to import airlines');
  const { db, close } = createDb({ url, max: 1 });

  try {
    console.log(`[airlines] downloading ${AIRLINES_URL}`);
    const dat = await downloadText(AIRLINES_URL);
    const existing = (await db.execute(sql`
      select iata, icao from airlines
      where iata is not null or icao is not null
    `)) as unknown as ExistingAirlineCode[];
    const rows = prepareAirlines(dat, existing);
    const withIcao = rows.filter((r) => r.icao !== null);
    const iataOnly = rows.filter((r) => r.icao === null && r.iata !== null);

    console.log(
      `[airlines] parsed ${rows.length.toLocaleString()} usable rows (${withIcao.length.toLocaleString()} ICAO, ${iataOnly.length.toLocaleString()} IATA-only)`,
    );

    let imported = 0;
    for (let i = 0; i < withIcao.length; i += CHUNK_SIZE) {
      const chunk = withIcao.slice(i, i + CHUNK_SIZE);
      await upsertByIcao(db, chunk);
      imported += chunk.length;
      logProgress(imported, rows.length);
    }
    for (let i = 0; i < iataOnly.length; i += CHUNK_SIZE) {
      const chunk = iataOnly.slice(i, i + CHUNK_SIZE);
      await upsertByIata(db, chunk);
      imported += chunk.length;
      logProgress(imported, rows.length);
    }

    await db.execute(sql`analyze airlines`);
    console.log('[airlines] done');
  } finally {
    await close();
  }
}

async function downloadText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed ${url}: ${res.status}`);
  return res.text();
}

function prepareAirlines(dat: string, existingRows: ExistingAirlineCode[]): AirlineImportRow[] {
  const existingIataOwner = new Map<string, string | null>();
  for (const row of existingRows) {
    if (row.iata) existingIataOwner.set(row.iata.toUpperCase(), row.icao?.toUpperCase() ?? null);
  }

  const byIcao = new Map<string, AirlineImportRow>();
  const iataOnly: AirlineImportRow[] = [];

  for (const fields of parseCsv(dat)) {
    const row = airlineFromFields(fields);
    if (!row) continue;
    if (row.iata && iataBelongsToAnotherIcao(row, existingIataOwner)) row.iata = null;
    if (row.icao) {
      const current = byIcao.get(row.icao);
      if (!current || airlineRank(row) > airlineRank(current)) byIcao.set(row.icao, row);
    } else if (row.iata) {
      iataOnly.push(row);
    }
  }

  const rows = [...byIcao.values()];
  const keeperByIata = new Map<string, AirlineImportRow>();
  for (const row of rows) {
    if (!row.iata) continue;
    const current = keeperByIata.get(row.iata);
    if (!current || airlineRank(row) > airlineRank(current)) keeperByIata.set(row.iata, row);
  }
  for (const row of rows) {
    if (row.iata && keeperByIata.get(row.iata) !== row) row.iata = null;
  }

  for (const row of iataOnly) {
    if (!row.iata || keeperByIata.has(row.iata)) continue;
    keeperByIata.set(row.iata, row);
    rows.push(row);
  }

  return rows.sort((a, b) => (a.icao ?? a.iata ?? '').localeCompare(b.icao ?? b.iata ?? ''));
}

function airlineFromFields(fields: string[]): AirlineImportRow | null {
  const name = clean(fields[1]);
  if (!name || name === 'Unknown' || name === 'Private flight') return null;
  const iata = cleanIata(fields[3]);
  const icao = cleanIcao(fields[4]);
  if (!iata && !icao) return null;
  return {
    iata,
    icao,
    name,
    callsign: clean(fields[5])?.toUpperCase() ?? null,
    country: clean(fields[6]),
    active: clean(fields[7]) !== 'N',
  };
}

function iataBelongsToAnotherIcao(
  row: AirlineImportRow,
  existingIataOwner: Map<string, string | null>,
): boolean {
  if (!row.iata) return false;
  const owner = existingIataOwner.get(row.iata);
  return owner !== undefined && owner !== null && owner !== row.icao;
}

async function upsertByIcao(db: ReturnType<typeof createDb>['db'], rows: AirlineImportRow[]) {
  if (rows.length === 0) return;
  const tuples = rows.map(
    (r) => sql`(${r.iata}, ${r.icao}, ${r.name}, ${r.callsign}, ${r.country}, ${r.active})`,
  );
  await db.execute(sql`
    insert into airlines (iata, icao, name, callsign, country, active)
    values ${sql.join(tuples, sql`, `)}
    on conflict (icao) do update set
      iata = case
        when airlines.provider_key is null then coalesce(excluded.iata, airlines.iata)
        else airlines.iata
      end,
      name = case when airlines.provider_key is null then excluded.name else airlines.name end,
      callsign = case
        when airlines.provider_key is null then excluded.callsign
        else airlines.callsign
      end,
      country = case when airlines.provider_key is null then excluded.country else airlines.country end,
      active = case when airlines.provider_key is null then excluded.active else airlines.active end,
      provider_key = airlines.provider_key,
      logo_url = airlines.logo_url,
      updated_at = now()
  `);
}

async function upsertByIata(db: ReturnType<typeof createDb>['db'], rows: AirlineImportRow[]) {
  if (rows.length === 0) return;
  const tuples = rows.map(
    (r) => sql`(${r.iata}, ${r.icao}, ${r.name}, ${r.callsign}, ${r.country}, ${r.active})`,
  );
  await db.execute(sql`
    insert into airlines (iata, icao, name, callsign, country, active)
    values ${sql.join(tuples, sql`, `)}
    on conflict (iata) do update set
      icao = case
        when airlines.provider_key is null then coalesce(airlines.icao, excluded.icao)
        else airlines.icao
      end,
      name = case when airlines.provider_key is null then excluded.name else airlines.name end,
      callsign = case
        when airlines.provider_key is null then excluded.callsign
        else airlines.callsign
      end,
      country = case when airlines.provider_key is null then excluded.country else airlines.country end,
      active = case when airlines.provider_key is null then excluded.active else airlines.active end,
      provider_key = airlines.provider_key,
      logo_url = airlines.logo_url,
      updated_at = now()
  `);
}

function airlineRank(row: AirlineImportRow): number {
  return (
    (row.active ? 100 : 0) +
    (row.iata ? 20 : 0) +
    (row.icao ? 10 : 0) +
    (row.callsign ? 5 : 0) +
    (row.country ? 1 : 0)
  );
}

function logProgress(imported: number, total: number): void {
  if (imported % (CHUNK_SIZE * 5) === 0 || imported === total) {
    console.log(`[airlines] imported ${imported.toLocaleString()}/${total.toLocaleString()}`);
  }
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
  if (!v || v === '\\N' || v === '-' || v === 'N/A') return null;
  return v;
}

function cleanIata(value: string | undefined): string | null {
  const v = clean(value)?.toUpperCase();
  return v && /^[A-Z0-9]{2}$/.test(v) ? v : null;
}

function cleanIcao(value: string | undefined): string | null {
  const v = clean(value)?.toUpperCase();
  return v && /^[A-Z0-9]{3}$/.test(v) ? v : null;
}

main().catch((err) => {
  console.error('[airlines] failed', err);
  process.exit(1);
});
