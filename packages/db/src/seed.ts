import { loadRootEnv } from '@flytrace/shared';
import { createDb } from './index.ts';
import { ewktPoint } from './schema/_custom.ts';
import { airlines, airports, providers, settings } from './schema/index.ts';

/**
 * Idempotent seed: reference airlines, major airports, provider registry rows
 * (disabled by default), and default runtime settings.
 * Usage: `bun run src/seed.ts` (reads DATABASE_URL).
 */
async function main() {
  loadRootEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required to run the seed');
  const { db, close } = createDb({ url, max: 1 });

  console.log('[seed] airlines…');
  await db
    .insert(airlines)
    .values([
      {
        iata: 'TK',
        icao: 'THY',
        name: 'Turkish Airlines',
        callsign: 'TURKISH',
        country: 'TR',
        providerKey: 'thy',
      },
      {
        iata: 'PC',
        icao: 'PGT',
        name: 'Pegasus Airlines',
        callsign: 'SUNTURK',
        country: 'TR',
        providerKey: 'pegasus',
      },
      {
        iata: 'VF',
        icao: 'AJA',
        name: 'AJet',
        callsign: 'AJET',
        country: 'TR',
        providerKey: 'ajet',
      },
      {
        iata: 'LH',
        icao: 'DLH',
        name: 'Lufthansa',
        callsign: 'LUFTHANSA',
        country: 'DE',
        providerKey: 'lufthansa',
      },
      {
        iata: 'BA',
        icao: 'BAW',
        name: 'British Airways',
        callsign: 'SPEEDBIRD',
        country: 'GB',
        providerKey: 'ba',
      },
    ])
    .onConflictDoNothing({ target: airlines.icao });

  console.log('[seed] airports…');
  await db
    .insert(airports)
    .values([
      {
        iata: 'IST',
        icao: 'LTFM',
        name: 'Istanbul Airport',
        city: 'Istanbul',
        country: 'TR',
        timezone: 'Europe/Istanbul',
        elevationFt: 325,
        location: ewktPoint(28.7519, 41.2753),
      },
      {
        iata: 'SAW',
        icao: 'LTFJ',
        name: 'Sabiha Gökçen',
        city: 'Istanbul',
        country: 'TR',
        timezone: 'Europe/Istanbul',
        elevationFt: 312,
        location: ewktPoint(29.3092, 40.8986),
      },
      {
        iata: 'ESB',
        icao: 'LTAC',
        name: 'Ankara Esenboğa',
        city: 'Ankara',
        country: 'TR',
        timezone: 'Europe/Istanbul',
        elevationFt: 3125,
        location: ewktPoint(32.9951, 40.1281),
      },
      {
        iata: 'LHR',
        icao: 'EGLL',
        name: 'London Heathrow',
        city: 'London',
        country: 'GB',
        timezone: 'Europe/London',
        elevationFt: 83,
        location: ewktPoint(-0.4543, 51.47),
      },
      {
        iata: 'FRA',
        icao: 'EDDF',
        name: 'Frankfurt',
        city: 'Frankfurt',
        country: 'DE',
        timezone: 'Europe/Berlin',
        elevationFt: 364,
        location: ewktPoint(8.5622, 50.0379),
      },
    ])
    .onConflictDoNothing({ target: airports.icao });

  console.log('[seed] providers (disabled by default)…');
  await db
    .insert(providers)
    .values([
      { key: 'aerodatabox', name: 'AeroDataBox', enabled: false },
      { key: 'thy', name: 'Turkish Airlines', enabled: false },
      { key: 'pegasus', name: 'Pegasus', enabled: false },
      { key: 'ajet', name: 'AJet', enabled: false },
      { key: 'lufthansa', name: 'Lufthansa', enabled: false },
      { key: 'ba', name: 'British Airways', enabled: false },
    ])
    .onConflictDoNothing({ target: providers.key });

  console.log('[seed] settings…');
  await db
    .insert(settings)
    .values([
      { key: 'opensky.poll_interval_ms', value: 6000, description: 'OpenSky poll cadence (ms)' },
      { key: 'map.max_markers', value: 4000, description: 'Max aircraft markers rendered' },
      {
        key: 'notifications.webpush.enabled',
        value: true,
        description: 'Web Push channel enabled',
      },
      {
        key: 'notifications.telegram.enabled',
        value: false,
        description: 'Telegram channel enabled',
      },
      { key: 'notifications.email.enabled', value: false, description: 'Email channel enabled' },
    ])
    .onConflictDoNothing({ target: settings.key });

  console.log('[seed] done');
  await close();
}

main().catch((err) => {
  console.error('[seed] failed', err);
  process.exit(1);
});
