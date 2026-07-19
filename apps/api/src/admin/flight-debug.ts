import { AppError } from '@flytrace/shared';
import { z } from 'zod';
import type { AppContext } from '../context.ts';

const debugFlightStateSchema = z
  .object({
    flightId: z.string(),
    icao24: z.string(),
    callsign: z.string().nullable(),
    lat: z.number(),
    lon: z.number(),
    lastTs: z.string(),
    qualityState: z.string().optional(),
    selectedProvider: z.string().optional(),
    candidateProviders: z.array(z.string()).optional(),
    providerCandidates: z.array(z.unknown()).optional(),
    sourceTimestamp: z.string().optional(),
    receivedAt: z.string().optional(),
    ageMs: z.number().optional(),
    lastAcceptedAt: z.string().optional(),
    lastRejectedAt: z.string().optional(),
    rejectionReason: z.string().optional(),
    rejectionHistory: z.array(z.unknown()).optional(),
    qualityScore: z.number().optional(),
    lastQualityTransitionAt: z.string().optional(),
    transitionHistory: z.array(z.unknown()).optional(),
    sequence: z.number().optional(),
    websocketPublishedAt: z.string().optional(),
  })
  .passthrough();

type DebugFlightState = z.infer<typeof debugFlightStateSchema>;

export interface FlightDebugResponse {
  flightId: string;
  icao24: string;
  currentState: {
    state: string | null;
    selectedProvider: string | null;
    candidateProviders: string[];
    sourceTimestamp: string | null;
    receivedAt: string | null;
    ageMs: number | null;
    lastAcceptedAt: string | null;
    lastRejectedAt: string | null;
    rejectionReason: string | null;
    qualityScore: number | null;
    lastTransitionAt: string | null;
    sequence: number | null;
    websocketPublishedAt: string | null;
  };
  lastObservation: {
    callsign: string | null;
    lat: number;
    lon: number;
    ts: string;
  };
  providerCandidates: unknown[];
  rejectionHistory: unknown[];
  transitionHistory: unknown[];
}

export async function readFlightDebug(
  ctx: Pick<AppContext, 'redis' | 'redisPrefix'>,
  icao24Param: string,
): Promise<FlightDebugResponse> {
  const icao24 = icao24Param.trim().toLowerCase();
  if (!icao24) throw new AppError('VALIDATION_ERROR', 'icao24 is required');

  const mappedFlightId = await ctx.redis.get(registryKey(ctx.redisPrefix, icao24));
  const mappedState = mappedFlightId ? await readState(ctx, mappedFlightId) : null;
  const state = mappedState ?? (await findStateByIcao24(ctx, icao24));
  if (!state) throw new AppError('NOT_FOUND', `flight ${icao24} is not active`);

  return {
    flightId: state.flightId,
    icao24: state.icao24,
    currentState: {
      state: state.qualityState ?? null,
      selectedProvider: state.selectedProvider ?? null,
      candidateProviders: state.candidateProviders ?? [],
      sourceTimestamp: state.sourceTimestamp ?? null,
      receivedAt: state.receivedAt ?? null,
      ageMs: state.ageMs ?? null,
      lastAcceptedAt: state.lastAcceptedAt ?? null,
      lastRejectedAt: state.lastRejectedAt ?? null,
      rejectionReason: state.rejectionReason ?? null,
      qualityScore: state.qualityScore ?? null,
      lastTransitionAt: state.lastQualityTransitionAt ?? null,
      sequence: state.sequence ?? null,
      websocketPublishedAt: state.websocketPublishedAt ?? null,
    },
    lastObservation: {
      callsign: state.callsign,
      lat: state.lat,
      lon: state.lon,
      ts: state.lastTs,
    },
    providerCandidates: state.providerCandidates ?? [],
    rejectionHistory: state.rejectionHistory ?? [],
    transitionHistory: state.transitionHistory ?? [],
  };
}

async function readState(
  ctx: Pick<AppContext, 'redis' | 'redisPrefix'>,
  flightId: string,
): Promise<DebugFlightState | null> {
  const raw = await ctx.redis.get(stateKey(ctx.redisPrefix, flightId));
  if (!raw) return null;
  const parsed = debugFlightStateSchema.safeParse(safeJson(raw));
  if (!parsed.success) throw new AppError('INTERNAL', `invalid hot state for ${flightId}`);
  return parsed.data;
}

async function findStateByIcao24(
  ctx: Pick<AppContext, 'redis' | 'redisPrefix'>,
  icao24: string,
): Promise<DebugFlightState | null> {
  const ids = await ctx.redis.smembers(`${ctx.redisPrefix}flights:active`);
  if (ids.length === 0) return null;
  const raws = await ctx.redis.mget(ids.map((id) => stateKey(ctx.redisPrefix, id)));
  for (const raw of raws) {
    if (!raw) continue;
    const parsed = debugFlightStateSchema.safeParse(safeJson(raw));
    if (parsed.success && parsed.data.icao24.toLowerCase() === icao24) return parsed.data;
  }
  return null;
}

function registryKey(prefix: string, icao24: string): string {
  return `${prefix}flight:key:${icao24}`;
}

function stateKey(prefix: string, flightId: string): string {
  return `${prefix}flight:state:${flightId}`;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
