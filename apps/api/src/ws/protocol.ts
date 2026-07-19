import { baseEnvelopeSchema } from '@flytrace/shared';
import { z } from 'zod';

/**
 * WebSocket wire protocol (docs/12 §12.4). All messages are JSON with a
 * discriminated `t` field and are Zod-validated in both directions.
 */

// ── Client → Server ──
export const clientMessageSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('subscribe'), channel: z.string(), cursor: z.string().optional() }),
  z.object({ t: z.literal('unsubscribe'), channel: z.string() }),
  z.object({
    t: z.literal('viewport'),
    bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]), // [w,s,e,n]
    zoom: z.number().optional(),
  }),
  z.object({ t: z.literal('ping') }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

// ── Server → Client ──
export const helloMessageSchema = z.object({
  t: z.literal('hello'),
  connectionId: z.string(),
  serverTime: z.string(),
  heartbeatMs: z.number(),
  resumeWindowMs: z.number(),
});
export const ackMessageSchema = z.object({
  t: z.literal('ack'),
  channel: z.string(),
  cursor: z.string().nullable(),
});
export const eventMessageSchema = z.object({
  t: z.literal('event'),
  channel: z.string(),
  id: z.string(),
  event: baseEnvelopeSchema,
});
export const bboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export const snapshotScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('viewport'), bbox: bboxSchema }),
  z.object({ kind: z.literal('flight'), flightId: z.string() }),
]);
export const snapshotMessageSchema = z.object({
  t: z.literal('snapshot'),
  channel: z.string(),
  snapshotId: z.string(),
  sequence: z.number().int().nonnegative(),
  generatedAt: z.string().datetime(),
  scope: snapshotScopeSchema,
  data: z.unknown(),
});
export const pongMessageSchema = z.object({ t: z.literal('pong') });
export const errorMessageSchema = z.object({
  t: z.literal('error'),
  code: z.string(),
  message: z.string(),
});
export const reconnectMessageSchema = z.object({ t: z.literal('reconnect'), reason: z.string() });

export const serverMessageSchema = z.discriminatedUnion('t', [
  helloMessageSchema,
  ackMessageSchema,
  eventMessageSchema,
  snapshotMessageSchema,
  pongMessageSchema,
  errorMessageSchema,
  reconnectMessageSchema,
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export function parseClientMessage(raw: string): ClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
