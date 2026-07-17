import { z } from 'zod';

/**
 * Domain event envelope — the single contract shared by the event bus, the
 * WebSocket layer, and clients. See docs/07-event-system.md §7.2.
 */

export const EVENT_TYPES = [
  'FlightDetected',
  'FlightUpdated',
  'PositionUpdated',
  'TakeoffDetected',
  'LandingDetected',
  'ClimbDetected',
  'DescentDetected',
  'EnteredAirspace',
  'AircraftChanged',
  'ProviderUpdated',
  'GateChanged',
  'DelayDetected',
  'FlightCancelled',
  'ArrivedAtGate',
  'NotificationRequested',
  'NotificationSent',
  'NotificationFailed',
  'FlightEnded',
] as const;

export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const PRODUCERS = ['tracker', 'worker', 'notifier', 'api'] as const;
export const producerSchema = z.enum(PRODUCERS);
export type Producer = z.infer<typeof producerSchema>;

/** Base envelope, generic over the payload schema. */
export function envelopeSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    id: z.string().uuid(),
    type: eventTypeSchema,
    version: z.number().int().positive(),
    occurredAt: z.string().datetime(),
    emittedAt: z.string().datetime(),
    producer: producerSchema,
    correlationId: z.string(),
    causationId: z.string().optional(),
    dedupeKey: z.string(),
    partitionKey: z.string(),
    payload,
  });
}

export const baseEnvelopeSchema = envelopeSchema(z.unknown());
export type EventEnvelope<T = unknown> = Omit<z.infer<typeof baseEnvelopeSchema>, 'payload'> & {
  payload: T;
};

// ── A few concrete payload schemas (extended per event in later phases) ──

export const positionPayloadSchema = z.object({
  flightId: z.string().uuid(),
  icao24: z.string(),
  lat: z.number(),
  lon: z.number(),
  altFt: z.number().nullable(),
  headingDeg: z.number().nullable(),
  gsKt: z.number().nullable(),
  vrateFpm: z.number().nullable(),
  onGround: z.boolean(),
  ts: z.string().datetime(),
});
export type PositionPayload = z.infer<typeof positionPayloadSchema>;

export const phaseEventPayloadSchema = z.object({
  flightId: z.string().uuid(),
  at: z.string().datetime(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  altFt: z.number().nullable().optional(),
  confidence: z.number().min(0).max(1),
  source: z.string(),
});
export type PhaseEventPayload = z.infer<typeof phaseEventPayloadSchema>;

/** Registry mapping each event type to its current schema version. */
export const EVENT_REGISTRY: Record<EventType, { version: number }> = Object.fromEntries(
  EVENT_TYPES.map((t) => [t, { version: 1 }]),
) as Record<EventType, { version: number }>;
