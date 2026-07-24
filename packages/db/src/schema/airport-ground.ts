import {
  doublePrecision,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { geometry } from './_custom.ts';
import { airports } from './catalog.ts';

/**
 * Airport ground geometry imported from OpenStreetMap (aeroway=*). One
 * polymorphic table keyed by `kind` keeps a single GiST spatial index and one
 * migration instead of six near-identical tables; the ground state engine
 * queries it (preloaded into a RAM spatial index) to place aircraft on gates,
 * taxiways and runways.
 */
export const airportFeatureKind = pgEnum('airport_feature_kind', [
  'runway',
  'taxiway',
  'apron',
  'terminal',
  'gate',
  'hangar',
  'parking',
]);

export const airportGeometries = pgTable(
  'airport_geometries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    airportId: uuid('airport_id')
      .notNull()
      .references(() => airports.id, { onDelete: 'cascade' }),
    kind: airportFeatureKind('kind').notNull(),
    /** Human ref: runway designator (e.g. "16L/34R") or gate/stand id. */
    ref: text('ref'),
    name: text('name'),
    geom: geometry('geom', { srid: 4326 }),
    source: text('source').notNull().default('osm'),
    osmId: text('osm_id'),
    datasetVersion: text('dataset_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_airport_geometries_geom').using('gist', t.geom),
    index('idx_airport_geometries_airport_kind').on(t.airportId, t.kind),
  ],
);

/**
 * Ground-movement timeline: one row per AirportStateChanged transition (the
 * worker projects the tracker's events here). `flight_id` is intentionally not
 * a FK — a ground event can arrive before the flight row is persisted; the
 * unique `dedupe_key` makes at-least-once stream delivery idempotent.
 */
export const airportGroundEvents = pgTable(
  'airport_ground_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flightId: uuid('flight_id').notNull(),
    icao24: text('icao24'),
    airportId: uuid('airport_id')
      .notNull()
      .references(() => airports.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    previousState: text('previous_state'),
    gateRef: text('gate_ref'),
    runwayRef: text('runway_ref'),
    lat: doublePrecision('lat'),
    lon: doublePrecision('lon'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    dedupeKey: text('dedupe_key').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_airport_ground_events_airport_time').on(t.airportId, t.occurredAt),
    index('idx_airport_ground_events_flight_time').on(t.flightId, t.occurredAt),
  ],
);
