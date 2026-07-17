import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { geographyPoint } from './_custom.ts';
import { eventType, flightStatus } from './_enums.ts';
import { aircraft, airlines, airports } from './catalog.ts';

/** Flights — the core flight-leg aggregate; everything hangs off it. */
export const flights = pgTable(
  'flights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    callsign: text('callsign').notNull(),
    flightNumber: text('flight_number'),
    airlineId: uuid('airline_id').references(() => airlines.id, { onDelete: 'set null' }),
    aircraftId: uuid('aircraft_id').references(() => aircraft.id, { onDelete: 'set null' }),
    originAirportId: uuid('origin_airport_id').references(() => airports.id, {
      onDelete: 'set null',
    }),
    destinationAirportId: uuid('destination_airport_id').references(() => airports.id, {
      onDelete: 'set null',
    }),
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }),
    scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }),
    estimatedDeparture: timestamp('estimated_departure', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }),
    actualDeparture: timestamp('actual_departure', { withTimezone: true }),
    actualArrival: timestamp('actual_arrival', { withTimezone: true }),
    status: flightStatus('status').notNull().default('unknown'),
    flightDate: date('flight_date').notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('uq_flights_callsign_date').on(t.callsign, t.flightDate),
    index('idx_flights_flight_number').on(t.flightNumber),
    index('idx_flights_status').on(t.status),
    index('idx_flights_last_seen').on(t.lastSeenAt),
    index('idx_flights_active').on(t.status).where(sql`${t.status} = 'active'`),
  ],
);

/** Flight positions — the track; high-volume time-series (partition by ts in infra). */
export const flightPositions = pgTable(
  'flight_positions',
  {
    flightId: uuid('flight_id')
      .notNull()
      .references(() => flights.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    icao24: char('icao24', { length: 6 }),
    location: geographyPoint('location', { srid: 4326 }),
    altitudeFt: integer('altitude_ft'),
    geoAltitudeFt: integer('geo_altitude_ft'),
    headingDeg: real('heading_deg'),
    groundSpeedKt: real('ground_speed_kt'),
    verticalRateFpm: integer('vertical_rate_fpm'),
    onGround: boolean('on_ground').notNull().default(false),
    squawk: text('squawk'),
    source: text('source').notNull().default('opensky'),
  },
  (t) => [
    primaryKey({ columns: [t.flightId, t.ts] }),
    index('idx_positions_location').using('gist', t.location),
    index('idx_positions_icao24_ts').on(t.icao24, t.ts),
  ],
);

/** Downsampled tracks — cheap long-term history. */
export const flightTracksDownsampled = pgTable(
  'flight_tracks_downsampled',
  {
    flightId: uuid('flight_id')
      .notNull()
      .references(() => flights.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull(),
    location: geographyPoint('location', { srid: 4326 }),
    altitudeFt: integer('altitude_ft'),
    headingDeg: real('heading_deg'),
    groundSpeedKt: real('ground_speed_kt'),
  },
  (t) => [primaryKey({ columns: [t.flightId, t.ts] })],
);

/** Flight events — derived domain facts (timeline / notifications / analytics). */
export const flightEvents = pgTable(
  'flight_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flightId: uuid('flight_id')
      .notNull()
      .references(() => flights.id, { onDelete: 'cascade' }),
    type: eventType('type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
    confidence: real('confidence').notNull().default(1),
    source: text('source').notNull(),
    payload: jsonb('payload'),
    dedupeKey: text('dedupe_key').notNull().unique(),
  },
  (t) => [
    index('idx_events_flight_time').on(t.flightId, t.occurredAt),
    index('idx_events_type_time').on(t.type, t.occurredAt),
  ],
);

/** Flight status — latest normalized provider status (1:1 with flight). */
export const flightStatusSnapshot = pgTable(
  'flight_status',
  {
    flightId: uuid('flight_id')
      .primaryKey()
      .references(() => flights.id, { onDelete: 'cascade' }),
    providerKey: text('provider_key').notNull(),
    status: flightStatus('status').notNull(),
    gate: text('gate'),
    terminal: text('terminal'),
    baggageBelt: text('baggage_belt'),
    scheduledDeparture: timestamp('scheduled_departure', { withTimezone: true }),
    estimatedDeparture: timestamp('estimated_departure', { withTimezone: true }),
    actualDeparture: timestamp('actual_departure', { withTimezone: true }),
    scheduledArrival: timestamp('scheduled_arrival', { withTimezone: true }),
    estimatedArrival: timestamp('estimated_arrival', { withTimezone: true }),
    actualArrival: timestamp('actual_arrival', { withTimezone: true }),
    raw: jsonb('raw'),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_flight_status_provider').on(t.providerKey, t.fetchedAt)],
);
