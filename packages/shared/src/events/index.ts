import { z } from 'zod';
import { type Clock, systemClock } from '../clock/index.ts';
import { correlationId as newCorrelationId, uuidv7 } from '../ids/index.ts';

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

/** Vertical flight phases carried by Climb/Descent events (incl. TOC/TOD). */
export const VERTICAL_PHASES = ['climb', 'descent', 'top_of_climb', 'top_of_descent'] as const;
export const verticalPhaseSchema = z.enum(VERTICAL_PHASES);
export type VerticalPhase = z.infer<typeof verticalPhaseSchema>;

export const phaseEventPayloadSchema = z.object({
  flightId: z.string().uuid(),
  phase: verticalPhaseSchema,
  at: z.string().datetime(),
  altFt: z.number().nullable(),
  vrateFpm: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  source: z.string(),
});
export type PhaseEventPayload = z.infer<typeof phaseEventPayloadSchema>;

/** Takeoff / Landing transition events. */
export const transitionPayloadSchema = z.object({
  flightId: z.string().uuid(),
  icao24: z.string(),
  at: z.string().datetime(),
  lat: z.number(),
  lon: z.number(),
  altFt: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  source: z.string(),
});
export type TransitionPayload = z.infer<typeof transitionPayloadSchema>;

export const flightDetectedPayloadSchema = z.object({
  flightId: z.string().uuid(),
  icao24: z.string(),
  callsign: z.string().nullable(),
  firstPosition: z.object({ lat: z.number(), lon: z.number(), ts: z.string().datetime() }),
  source: z.string(),
});
export type FlightDetectedPayload = z.infer<typeof flightDetectedPayloadSchema>;

export const FLIGHT_END_REASONS = ['landed', 'arrived', 'timeout', 'diverted'] as const;
export const flightEndReasonSchema = z.enum(FLIGHT_END_REASONS);
export type FlightEndReason = z.infer<typeof flightEndReasonSchema>;

export const flightEndedPayloadSchema = z.object({
  flightId: z.string().uuid(),
  icao24: z.string(),
  endedAt: z.string().datetime(),
  reason: flightEndReasonSchema,
});
export type FlightEndedPayload = z.infer<typeof flightEndedPayloadSchema>;

/** Registry mapping each event type to its current schema version. */
export const EVENT_REGISTRY: Record<EventType, { version: number }> = Object.fromEntries(
  EVENT_TYPES.map((t) => [t, { version: 1 }]),
) as Record<EventType, { version: number }>;

/**
 * A producer's intent to emit an event — everything that is deterministic from
 * the domain (no ids, no processing-time). The bus/producer wraps it into a
 * full {@link EventEnvelope} via {@link makeEnvelope}. Keeping this pure makes
 * detector output golden-file testable.
 */
export interface DomainEventInput<T = unknown> {
  type: EventType;
  payload: T;
  /** Event time — when the fact happened (from the observation). */
  occurredAt: string;
  dedupeKey: string;
  partitionKey: string;
  causationId?: string;
}

/** Wrap a {@link DomainEventInput} into a validated, transport-ready envelope. */
export function makeEnvelope<T>(
  input: DomainEventInput<T>,
  opts: { producer: Producer; clock?: Clock; correlationId?: string },
): EventEnvelope<T> {
  const clock = opts.clock ?? systemClock;
  const envelope: EventEnvelope<T> = {
    id: uuidv7(clock.now()),
    type: input.type,
    version: EVENT_REGISTRY[input.type].version,
    occurredAt: input.occurredAt,
    emittedAt: clock.nowIso(),
    producer: opts.producer,
    correlationId: opts.correlationId ?? newCorrelationId(),
    dedupeKey: input.dedupeKey,
    partitionKey: input.partitionKey,
    payload: input.payload,
    ...(input.causationId !== undefined ? { causationId: input.causationId } : {}),
  };
  return envelope;
}
