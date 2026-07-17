import {
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { geographyPoint } from './_custom.ts';

/** Airlines — stable identity + branding + provider mapping. */
export const airlines = pgTable(
  'airlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    iata: char('iata', { length: 2 }).unique(),
    icao: char('icao', { length: 3 }).unique(),
    name: text('name').notNull(),
    callsign: text('callsign'),
    country: text('country'),
    logoUrl: text('logo_url'),
    providerKey: text('provider_key'),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_airlines_provider_key').on(t.providerKey)],
);

/** Airports — origin/destination, airport pages, geofencing. */
export const airports = pgTable(
  'airports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    iata: char('iata', { length: 3 }).unique(),
    icao: char('icao', { length: 4 }).notNull().unique(),
    name: text('name').notNull(),
    city: text('city'),
    country: text('country'),
    location: geographyPoint('location', { srid: 4326 }),
    elevationFt: integer('elevation_ft'),
    timezone: text('timezone'),
    runways: jsonb('runways'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_airports_location').using('gist', t.location)],
);

/** Aircraft — enrichment, aircraft pages, ADS-B join key (icao24). */
export const aircraft = pgTable(
  'aircraft',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    icao24: char('icao24', { length: 6 }).notNull().unique(),
    registration: text('registration').unique(),
    typeIcao: text('type_icao'),
    typeName: text('type_name'),
    airlineId: uuid('airline_id').references(() => airlines.id, { onDelete: 'set null' }),
    manufacturer: text('manufacturer'),
    builtYear: integer('built_year'),
    seats: integer('seats'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_aircraft_airline').on(t.airlineId), index('idx_aircraft_type').on(t.typeIcao)],
);
