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
  geoAltitudeFt: z.number().nullable().optional(),
  headingDeg: z.number().nullable(),
  groundSpeedKt: z.number().nullable(),
  verticalRateFpm: z.number().nullable().optional(),
  onGround: z.boolean(),
  squawk: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  qualityState: flightQualityStateSchema.optional(),
  source: z.string().optional(),
  sourceTimestamp: z.string().optional(),
  ageMs: z.number().int().nonnegative().optional(),
  qualityScore: z.number().min(0).max(1).optional(),
  positionSource: z.string().optional(),
  isMlat: z.boolean().optional(),
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
      flightId: z.string().optional(),
      icao24: z.string().optional(),
      callsign: z.string().nullable().optional(),
      lat: z.number().nullable(),
      lon: z.number().nullable(),
      altitudeFt: z.number().nullable(),
      geoAltitudeFt: z.number().nullable().optional(),
      headingDeg: z.number().nullable(),
      groundSpeedKt: z.number().nullable(),
      verticalRateFpm: z.number().nullable(),
      onGround: z.boolean(),
      squawk: z.string().nullable().optional(),
      category: z.string().nullable().optional(),
      qualityState: flightQualityStateSchema.optional(),
      source: z.string().nullable().optional(),
      sourceTimestamp: z.string().optional(),
      receivedAt: z.string().optional(),
      ageMs: z.number().int().nonnegative().optional(),
      qualityScore: z.number().min(0).max(1).optional(),
      positionSource: z.string().optional(),
      isMlat: z.boolean().optional(),
      ts: z.string(),
    })
    .nullable(),
  statusSnapshot: z
    .object({
      providerKey: z.string(),
      status: z.string(),
      gate: z.string().nullable(),
      terminal: z.string().nullable(),
      baggageBelt: z.string().nullable(),
      scheduledDeparture: z.string().nullable(),
      estimatedDeparture: z.string().nullable(),
      actualDeparture: z.string().nullable(),
      scheduledArrival: z.string().nullable(),
      estimatedArrival: z.string().nullable(),
      actualArrival: z.string().nullable(),
      fetchedAt: z.string(),
    })
    .nullable()
    .optional(),
  timeline: z.array(flightEventSchema),
});
export type FlightDetail = z.infer<typeof flightDetailSchema>;

export const liveStatsSchema = z.object({
  flightsLive: z.number(),
  eventsToday: z.number(),
});
export type LiveStats = z.infer<typeof liveStatsSchema>;

export const weatherSeveritySchema = z.enum(['none', 'low', 'moderate', 'high', 'severe']);
export type WeatherSeverity = z.infer<typeof weatherSeveritySchema>;

export const weatherKindSchema = z.enum(['clear', 'rain', 'storm', 'wind', 'snow', 'fog']);
export type WeatherKind = z.infer<typeof weatherKindSchema>;

export const weatherPointSchema = z.object({
  lat: z.number(),
  lon: z.number(),
  observedAt: z.string(),
  model: z.literal('open-meteo'),
  condition: z.object({
    code: z.number(),
    label: z.string(),
    kind: weatherKindSchema,
    severity: weatherSeveritySchema,
  }),
  temperatureC: z.number().nullable(),
  precipitationMm: z.number().nullable(),
  rainMm: z.number().nullable(),
  showersMm: z.number().nullable(),
  snowfallCm: z.number().nullable(),
  cloudCoverPct: z.number().nullable(),
  visibilityM: z.number().nullable(),
  wind: z.object({
    speedKt: z.number().nullable(),
    directionDeg: z.number().nullable(),
    gustKt: z.number().nullable(),
  }),
  convection: z.object({
    capeJkg: z.number().nullable(),
  }),
  altitude: z
    .object({
      requestedFt: z.number(),
      pressureLevelHpa: z.number(),
      windSpeedKt: z.number().nullable(),
      windDirectionDeg: z.number().nullable(),
      verticalVelocityMs: z.number().nullable(),
      windShearKt: z.number().nullable(),
    })
    .nullable(),
  turbulence: z.object({
    estimated: z.literal(true),
    level: weatherSeveritySchema,
    score: z.number().min(0).max(100),
    reasons: z.array(z.string()),
  }),
});
export type WeatherPoint = z.infer<typeof weatherPointSchema>;

export const weatherMapFeatureCollectionSchema = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(
    z.object({
      type: z.literal('Feature'),
      id: z.string(),
      geometry: z.object({
        type: z.literal('Point'),
        coordinates: z.tuple([z.number(), z.number()]),
      }),
      properties: z.object({
        id: z.string(),
        kind: weatherKindSchema,
        severity: weatherSeveritySchema,
        label: z.string(),
        code: z.number(),
        observedAt: z.string(),
        temperatureC: z.number().nullable(),
        precipitationMm: z.number().nullable(),
        windKt: z.number().nullable(),
        gustKt: z.number().nullable(),
        capeJkg: z.number().nullable(),
      }),
    }),
  ),
  count: z.number().int().nonnegative(),
  sampleCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
  model: z.literal('open-meteo'),
});
export type WeatherMapFeatureCollection = z.infer<typeof weatherMapFeatureCollectionSchema>;
