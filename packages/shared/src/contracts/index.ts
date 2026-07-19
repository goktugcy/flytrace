import { z } from 'zod';
import { flightQualityStateSchema } from '../events/index.ts';

/**
 * Public API response contracts (docs/11 §11.1 — contracts as SSOT). The API
 * serializes to these; the web client infers its types from them. Kept minimal
 * for the Phase 1 flight/map surface.
 */

/** A live aircraft as served by GET /flights/live and the WS viewport snapshot. */
export const liveFlightSchema = z.object({
  flightId: z.string(),
  icao24: z.string(),
  callsign: z.string().nullable(),
  lat: z.number(),
  lon: z.number(),
  altitudeFt: z.number().nullable(),
  headingDeg: z.number().nullable(),
  groundSpeedKt: z.number().nullable(),
  onGround: z.boolean(),
  qualityState: flightQualityStateSchema.optional(),
  receivedAt: z.string().optional(),
  ts: z.string(),
});
export type LiveFlight = z.infer<typeof liveFlightSchema>;

export const trackPointSchema = z.object({
  ts: z.string(),
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  altitudeFt: z.number().nullable(),
  headingDeg: z.number().nullable(),
  groundSpeedKt: z.number().nullable(),
});
export type TrackPoint = z.infer<typeof trackPointSchema>;

export const flightEventSchema = z.object({
  type: z.string(),
  occurredAt: z.string(),
  confidence: z.number(),
  source: z.string(),
});
export type FlightEventDto = z.infer<typeof flightEventSchema>;

export const flightDetailSchema = z.object({
  flight: z.object({
    flightId: z.string(),
    callsign: z.string(),
    flightNumber: z.string().nullable(),
    status: z.string(),
    flightDate: z.string(),
    source: z.string().nullable(),
  }),
  live: z
    .object({
      lat: z.number().nullable(),
      lon: z.number().nullable(),
      altitudeFt: z.number().nullable(),
      headingDeg: z.number().nullable(),
      groundSpeedKt: z.number().nullable(),
      verticalRateFpm: z.number().nullable(),
      onGround: z.boolean(),
      ts: z.string(),
    })
    .nullable(),
  timeline: z.array(flightEventSchema),
});
export type FlightDetail = z.infer<typeof flightDetailSchema>;

export const liveStatsSchema = z.object({
  flightsLive: z.number(),
  eventsToday: z.number(),
});
export type LiveStats = z.infer<typeof liveStatsSchema>;
