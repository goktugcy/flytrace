import type { Clock, Logger } from '@flytrace/shared';
import type { Position } from '../domain/position.ts';
import type { PositionSource } from './port.ts';

export interface CompositePositionSourceOptions {
  sources: PositionSource[];
  logger: Logger;
  clock: Clock;
  maxPositionAgeMs: number;
  switchMargin: number;
  maxJumpSpeedKt: number;
  providerPriority: Record<string, number>;
}

interface Candidate {
  source: string;
  position: Position;
  score: number;
}

interface Selected {
  source: string;
  position: Position;
  score: number;
}

const EARTH_RADIUS_NM = 3440.065;

/**
 * Polls multiple live position sources and emits one best observation per ICAO24.
 * Each source is isolated: timeout/rate-limit failures in one provider do not
 * fail the whole tracker tick.
 */
export class CompositePositionSource implements PositionSource {
  readonly name = 'composite';
  readonly timeMode = 'wall';
  private readonly selected = new Map<string, Selected>();

  constructor(private readonly opts: CompositePositionSourceOptions) {}

  async poll(): Promise<Position[]> {
    const nowMs = this.opts.clock.now();
    const settled = await Promise.allSettled(
      this.opts.sources.map(async (source) => ({
        source,
        positions: await source.poll(),
      })),
    );

    const byIcao = new Map<string, Candidate[]>();
    for (const result of settled) {
      if (result.status === 'rejected') {
        this.opts.logger.warn('position provider poll failed', { err: String(result.reason) });
        continue;
      }

      const { source, positions } = result.value;
      for (const raw of positions) {
        const candidate = this.toCandidate(source.name, raw, nowMs);
        if (!candidate) continue;
        const list = byIcao.get(candidate.position.icao24) ?? [];
        list.push(candidate);
        byIcao.set(candidate.position.icao24, list);
      }
    }

    const out: Position[] = [];
    for (const [icao24, candidates] of byIcao) {
      const chosen = this.choose(icao24, candidates);
      if (!chosen) continue;
      this.selected.set(icao24, {
        source: chosen.source,
        position: chosen.position,
        score: chosen.score,
      });
      out.push(chosen.position);
    }
    return out;
  }

  private toCandidate(sourceName: string, raw: Position, nowMs: number): Candidate | null {
    if (!validCoordinates(raw.lat, raw.lon)) return null;

    const source = raw.source ?? sourceName;
    const sourceTimestamp = raw.sourceTimestamp ?? raw.ts;
    const tsMs = Date.parse(sourceTimestamp);
    if (!Number.isFinite(tsMs)) return null;

    const ageMs = raw.ageMs ?? Math.max(0, nowMs - tsMs);
    if (ageMs > this.opts.maxPositionAgeMs) {
      this.opts.logger.debug('dropping stale provider candidate', {
        icao24: raw.icao24,
        source,
        age_ms: ageMs,
      });
      return null;
    }

    const previous = this.selected.get(raw.icao24);
    if (previous && !this.isPlausible(previous.position, raw)) {
      this.opts.logger.warn('dropping implausible provider jump', {
        icao24: raw.icao24,
        from: previous.source,
        to: source,
      });
      return null;
    }

    const position: Position = {
      ...raw,
      source,
      sourceTimestamp,
      receivedAt: raw.receivedAt ?? new Date(nowMs).toISOString(),
      ageMs,
    };
    const score = scorePosition(position, {
      maxPositionAgeMs: this.opts.maxPositionAgeMs,
      priority: this.opts.providerPriority[source] ?? 0,
    });
    return {
      source,
      position: { ...position, quality: score },
      score,
    };
  }

  private choose(icao24: string, candidates: Candidate[]): Candidate | null {
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (!best) return null;

    const current = this.selected.get(icao24);
    if (!current || current.source === best.source) return best;

    const currentCandidate = ranked.find((c) => c.source === current.source);
    if (currentCandidate && best.score < currentCandidate.score + this.opts.switchMargin) {
      return currentCandidate;
    }
    return best;
  }

  private isPlausible(prev: Position, next: Position): boolean {
    const prevMs = Date.parse(prev.sourceTimestamp ?? prev.ts);
    const nextMs = Date.parse(next.sourceTimestamp ?? next.ts);
    if (!Number.isFinite(prevMs) || !Number.isFinite(nextMs) || nextMs <= prevMs) return true;
    const hours = (nextMs - prevMs) / 3_600_000;
    if (hours <= 0) return true;
    const speedKt = distanceNm(prev.lat, prev.lon, next.lat, next.lon) / hours;
    return speedKt <= this.opts.maxJumpSpeedKt;
  }
}

export function scorePosition(
  p: Position,
  opts: { maxPositionAgeMs: number; priority: number },
): number {
  const ageMs = p.ageMs ?? Math.max(0, Date.now() - Date.parse(p.sourceTimestamp ?? p.ts));
  const freshness = clamp01(1 - ageMs / opts.maxPositionAgeMs);
  const completeness =
    Number(p.callsign !== null) * 0.15 +
    Number(p.altFt !== null) * 0.2 +
    Number(p.headingDeg !== null) * 0.2 +
    Number(p.gsKt !== null) * 0.2 +
    Number(p.vrateFpm !== null) * 0.1 +
    Number(p.category !== null) * 0.15;
  const sourceType = p.isMlat ? 0.75 : 1;
  const priority = clamp01(opts.priority / 100);
  return round3(freshness * 0.45 + completeness * 0.2 + sourceType * 0.25 + priority * 0.1);
}

function validCoordinates(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dPhi = toRad(lat2 - lat1);
  const dLambda = toRad(lon2 - lon1);
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
