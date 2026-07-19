import type { FlightRepo, PositionInput } from '@flytrace/db';
import {
  type EventEnvelope,
  type Logger,
  type PositionPayload,
  domainToDbEventType,
} from '@flytrace/shared';

/** Re-exported for tests; the mapping itself is shared (docs/07). */
export const dbEventType = domainToDbEventType;

/**
 * Projects tracker domain events into Postgres (docs/06 §6.7). Positions are
 * buffered and flushed in batches (high volume, must never block the stream);
 * flights/events are written immediately and idempotently. At-least-once stream
 * delivery is safe because every write dedupes (PK / unique dedupe_key).
 */
export interface PersisterOptions {
  /** Flush the position buffer once it reaches this size. */
  maxPositionBatch: number;
}

const FLIGHT_END_REASONS = new Set(['landed', 'arrived', 'timeout', 'diverted']);

function utcDate(iso: string): string {
  return iso.slice(0, 10); // YYYY-MM-DD
}

function confidenceOf(env: EventEnvelope): number {
  const p = env.payload as { confidence?: unknown };
  return typeof p.confidence === 'number' ? p.confidence : 1;
}

export class Persister {
  private positions: PositionInput[] = [];

  constructor(
    private readonly repo: FlightRepo,
    private readonly logger: Logger,
    private readonly options: PersisterOptions = { maxPositionBatch: 500 },
  ) {}

  async handle(env: EventEnvelope): Promise<void> {
    switch (env.type) {
      case 'FlightDetected':
        await this.onDetected(env);
        break;
      case 'PositionUpdated':
        this.bufferPosition(env);
        if (this.positions.length >= this.options.maxPositionBatch) await this.flush();
        break;
      case 'FlightEnded':
        await this.flush(); // land positions before finalizing the leg
        await this.onEnded(env);
        break;
      default:
        await this.onDerivedEvent(env);
    }
  }

  /** Flush buffered positions. Called after each stream batch and before end. */
  async flush(): Promise<void> {
    if (this.positions.length === 0) return;
    const batch = this.positions;
    this.positions = [];
    const n = await this.repo.insertPositions(batch);
    this.logger.debug('flushed positions', { count: n });
  }

  private async onDetected(env: EventEnvelope): Promise<void> {
    const p = env.payload as {
      flightId: string;
      icao24: string;
      callsign: string | null;
      firstPosition: { ts: string };
      source: string;
    };
    await this.repo.upsertFlight({
      flightId: p.flightId,
      callsign: p.callsign ?? p.icao24,
      flightDate: utcDate(p.firstPosition.ts),
      source: p.source,
      lastSeenAt: new Date(env.occurredAt),
    });
    await this.writeEvent(env);
  }

  private bufferPosition(env: EventEnvelope): void {
    const p = env.payload as PositionPayload;
    this.positions.push({
      flightId: p.flightId,
      ts: new Date(p.ts),
      icao24: p.icao24,
      lon: p.lon,
      lat: p.lat,
      altitudeFt: p.altFt === null ? null : Math.round(p.altFt),
      geoAltitudeFt:
        p.geoAltitudeFt === undefined || p.geoAltitudeFt === null
          ? null
          : Math.round(p.geoAltitudeFt),
      headingDeg: p.headingDeg,
      groundSpeedKt: p.gsKt,
      verticalRateFpm: p.vrateFpm === null ? null : Math.round(p.vrateFpm),
      onGround: p.onGround,
      squawk: p.squawk ?? null,
      source: p.source ?? env.producer,
    });
  }

  private async onEnded(env: EventEnvelope): Promise<void> {
    const p = env.payload as { flightId: string; endedAt: string; reason: string };
    const reason = FLIGHT_END_REASONS.has(p.reason) ? (p.reason as 'landed') : 'landed';
    await this.repo.endFlight(p.flightId, new Date(p.endedAt), reason);
    await this.writeEvent(env);
  }

  private async onDerivedEvent(env: EventEnvelope): Promise<void> {
    await this.writeEvent(env);
  }

  private async writeEvent(env: EventEnvelope): Promise<void> {
    const type = dbEventType(env);
    if (!type) return;
    await this.repo.insertEvent({
      flightId: env.partitionKey,
      type,
      occurredAt: new Date(env.occurredAt),
      confidence: confidenceOf(env),
      source: env.producer,
      payload: env.payload,
      dedupeKey: env.dedupeKey,
    });
  }
}
