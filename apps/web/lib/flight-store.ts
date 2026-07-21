/**
 * Framework-agnostic live-flight store (docs/12 §12.5). Holds the latest sample
 * per aircraft, guards against out-of-order deltas, reconciles authoritative
 * viewport snapshots, and prunes stale targets as a client-side safety net.
 */
export type FlightQualityState = 'live' | 'delayed' | 'stale' | 'signal_lost';

export interface FlightLifecycleConfig {
  liveAfterMs: number;
  delayedAfterMs: number;
  staleAfterMs: number;
  removeAfterMs: number;
}

export const CLIENT_FLIGHT_LIFECYCLE: FlightLifecycleConfig = {
  liveAfterMs: 15_000,
  delayedAfterMs: 30_000,
  staleAfterMs: 60_000,
  removeAfterMs: 90_000,
};

export interface FlightSample {
  flightId: string;
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  heading: number | null;
  altFt: number | null;
  geoAltitudeFt: number | null;
  gsKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  squawk: string | null;
  /** Coarse aircraft class (light | jet | heavy | helo) for map icons. */
  category: string | null;
  source: string | null;
  sourceTimestamp: string | null;
  ageMs: number | null;
  qualityScore: number | null;
  positionSource: string | null;
  isMlat: boolean | null;
  /** Freshness derived from server lifecycle events or local age. */
  qualityState: FlightQualityState;
  /** Client receive time for reconnect/snapshot ordering. */
  receivedAtMs: number;
  /** Realtime connection generation that last touched this row. */
  connectionGeneration: number;
  ts: string;
  tsMs: number;
}

type Listener = () => void;
type Bbox = [west: number, south: number, east: number, north: number];

interface SnapshotScope {
  kind: 'viewport' | 'flight';
  bbox?: Bbox;
  flightId?: string;
}

interface SnapshotMeta {
  channel?: string;
  snapshotId?: string;
  sequence?: number;
  generatedAt?: string;
  scope?: SnapshotScope;
}

const QUALITY_STATES = new Set<FlightQualityState>(['live', 'delayed', 'stale', 'signal_lost']);

const EVENT_ID_LIMIT = 2048;

export class FlightStore {
  private readonly map = new Map<string, FlightSample>();
  private readonly listeners = new Set<Listener>();
  private readonly seenEventIds: string[] = [];
  private readonly seenEventIdSet = new Set<string>();
  private readonly seenSnapshotIds = new Set<string>();
  private connectionGeneration = 0;
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  list(): FlightSample[] {
    return [...this.map.values()];
  }

  get(flightId: string): FlightSample | undefined {
    return this.map.get(flightId);
  }

  setConnectionGeneration(generation: number): void {
    this.connectionGeneration = generation;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Apply a PositionUpdated payload. Returns false if dropped as stale. */
  applyPosition(p: {
    flightId: string;
    icao24: string;
    callsign?: string | null;
    lat: number;
    lon: number;
    headingDeg: number | null;
    altFt: number | null;
    geoAltitudeFt?: number | null;
    gsKt: number | null;
    verticalRateFpm?: number | null;
    onGround: boolean;
    squawk?: string | null;
    category?: string | null;
    source?: string | null;
    sourceTimestamp?: string | null;
    ageMs?: number | null;
    quality?: number | null;
    qualityScore?: number | null;
    positionSource?: string | null;
    isMlat?: boolean | null;
    qualityState?: string;
    receivedAt?: string;
    ts: string;
  }): boolean {
    const tsMs = parseIsoMs(p.ts);
    if (tsMs === null) return false;
    const prev = this.map.get(p.flightId);
    if (prev && tsMs <= prev.tsMs) return false;

    const receivedAtMs = parseIsoMs(p.receivedAt) ?? this.now();
    this.map.set(p.flightId, {
      flightId: p.flightId,
      icao24: p.icao24,
      callsign: p.callsign ?? prev?.callsign ?? null,
      lat: p.lat,
      lon: p.lon,
      heading: p.headingDeg,
      altFt: p.altFt,
      geoAltitudeFt: optionalValue(p.geoAltitudeFt, prev?.geoAltitudeFt ?? null),
      gsKt: p.gsKt,
      verticalRateFpm: optionalValue(p.verticalRateFpm, prev?.verticalRateFpm ?? null),
      onGround: p.onGround,
      squawk: optionalValue(p.squawk, prev?.squawk ?? null),
      category: optionalValue(p.category, prev?.category ?? null),
      source: optionalValue(p.source, prev?.source ?? null),
      sourceTimestamp: optionalValue(p.sourceTimestamp, prev?.sourceTimestamp ?? null),
      ageMs: optionalValue(p.ageMs, prev?.ageMs ?? null),
      qualityScore: optionalValue(
        p.qualityScore !== undefined ? p.qualityScore : p.quality,
        prev?.qualityScore ?? null,
      ),
      positionSource: optionalValue(p.positionSource, prev?.positionSource ?? null),
      isMlat: optionalValue(p.isMlat, prev?.isMlat ?? null),
      qualityState: normalizeQuality(p.qualityState) ?? 'live',
      receivedAtMs,
      connectionGeneration: this.connectionGeneration,
      ts: p.ts,
      tsMs,
    });
    this.emit();
    return true;
  }

  /** Seed from a hot-state snapshot row (viewport/flight snapshot). */
  applySnapshotState(s: {
    flightId: string;
    icao24: string;
    callsign?: string | null;
    lat: number;
    lon: number;
    headingDeg?: number | null;
    altFt: number | null;
    geoAltitudeFt?: number | null;
    gsKt: number | null;
    vrateFpm?: number | null;
    verticalRateFpm?: number | null;
    airborne?: boolean;
    onGround?: boolean;
    squawk?: string | null;
    category?: string | null;
    selectedProvider?: string | null;
    source?: string | null;
    sourceTimestamp?: string | null;
    ageMs?: number | null;
    qualityScore?: number | null;
    positionSource?: string | null;
    isMlat?: boolean | null;
    qualityState?: string;
    lastAcceptedAt?: string;
    lastTs: string;
  }): boolean {
    const changed = this.applySnapshotStateInternal(s, this.now());
    if (changed) this.emit();
    return changed;
  }

  /** Apply and reconcile an authoritative server snapshot. */
  applySnapshot(data: unknown, meta: SnapshotMeta = {}): void {
    if (meta.snapshotId) {
      if (this.seenSnapshotIds.has(meta.snapshotId)) return;
      this.seenSnapshotIds.add(meta.snapshotId);
    }

    const generatedAtMs = parseIsoMs(meta.generatedAt) ?? this.now();
    let changed = false;
    if (Array.isArray(data)) {
      const incoming = new Set<string>();
      for (const row of data) {
        const flightId = flightIdOf(row);
        if (!flightId) continue;
        incoming.add(flightId);
        changed = this.applySnapshotStateInternal(row as never, generatedAtMs) || changed;
      }
      if (meta.scope?.kind === 'viewport' && meta.scope.bbox) {
        changed =
          this.reconcileViewportSnapshot(incoming, meta.scope.bbox, generatedAtMs) || changed;
      }
    } else if (flightIdOf(data)) {
      changed = this.applySnapshotStateInternal(data as never, generatedAtMs);
    }
    if (changed) this.emit();
  }

  updateQuality(flightId: string, quality: string | undefined): boolean {
    const nextQuality = normalizeQuality(quality);
    const prev = this.map.get(flightId);
    if (!prev || !nextQuality || prev.qualityState === nextQuality) return false;
    this.map.set(flightId, {
      ...prev,
      qualityState: nextQuality,
      receivedAtMs: this.now(),
    });
    this.emit();
    return true;
  }

  pruneStale(nowMs = this.now(), cfg: FlightLifecycleConfig = CLIENT_FLIGHT_LIFECYCLE): number {
    let changed = false;
    let removed = 0;
    for (const [flightId, sample] of this.map) {
      const ageMs = Math.max(0, nowMs - sample.tsMs);
      if (ageMs > cfg.removeAfterMs) {
        this.map.delete(flightId);
        removed += 1;
        changed = true;
        continue;
      }
      const qualityState = classifyFlightSample(sample, nowMs, cfg);
      if (qualityState !== sample.qualityState) {
        this.map.set(flightId, { ...sample, qualityState });
        changed = true;
      }
    }
    if (changed) this.emit();
    return removed;
  }

  remove(flightId: string): void {
    if (this.map.delete(flightId)) this.emit();
  }

  markEventSeen(id: unknown): boolean {
    if (typeof id !== 'string' || !id) return true;
    if (this.seenEventIdSet.has(id)) return false;
    this.seenEventIdSet.add(id);
    this.seenEventIds.push(id);
    while (this.seenEventIds.length > EVENT_ID_LIMIT) {
      const old = this.seenEventIds.shift();
      if (old) this.seenEventIdSet.delete(old);
    }
    return true;
  }

  private applySnapshotStateInternal(
    s: {
      flightId: string;
      icao24: string;
      callsign?: string | null;
      lat: number;
      lon: number;
      headingDeg?: number | null;
      altFt: number | null;
      geoAltitudeFt?: number | null;
      gsKt: number | null;
      vrateFpm?: number | null;
      verticalRateFpm?: number | null;
      airborne?: boolean;
      onGround?: boolean;
      squawk?: string | null;
      category?: string | null;
      selectedProvider?: string | null;
      source?: string | null;
      sourceTimestamp?: string | null;
      ageMs?: number | null;
      qualityScore?: number | null;
      positionSource?: string | null;
      isMlat?: boolean | null;
      qualityState?: string;
      lastAcceptedAt?: string;
      lastTs: string;
    },
    generatedAtMs: number,
  ): boolean {
    const tsMs = parseIsoMs(s.lastTs);
    if (tsMs === null) return false;
    const prev = this.map.get(s.flightId);
    if (prev && tsMs < prev.tsMs) return false;
    if (prev && tsMs === prev.tsMs && prev.receivedAtMs > generatedAtMs) return false;

    const receivedAtMs = parseIsoMs(s.lastAcceptedAt) ?? generatedAtMs;
    const qualityState =
      normalizeQuality(s.qualityState) ??
      classifyAge(Math.max(0, generatedAtMs - tsMs), CLIENT_FLIGHT_LIFECYCLE);
    const onGround =
      typeof s.onGround === 'boolean'
        ? s.onGround
        : typeof s.airborne === 'boolean'
          ? !s.airborne
          : (prev?.onGround ?? false);

    this.map.set(s.flightId, {
      flightId: s.flightId,
      icao24: s.icao24,
      callsign: s.callsign ?? prev?.callsign ?? null,
      lat: s.lat,
      lon: s.lon,
      heading: s.headingDeg ?? null,
      altFt: s.altFt,
      geoAltitudeFt: optionalValue(s.geoAltitudeFt, prev?.geoAltitudeFt ?? null),
      gsKt: s.gsKt,
      verticalRateFpm: optionalValue(
        s.verticalRateFpm !== undefined ? s.verticalRateFpm : s.vrateFpm,
        prev?.verticalRateFpm ?? null,
      ),
      onGround,
      squawk: optionalValue(s.squawk, prev?.squawk ?? null),
      category: optionalValue(s.category, prev?.category ?? null),
      source: optionalValue(
        s.source !== undefined ? s.source : s.selectedProvider,
        prev?.source ?? null,
      ),
      sourceTimestamp: optionalValue(s.sourceTimestamp, prev?.sourceTimestamp ?? null),
      ageMs: optionalValue(s.ageMs, prev?.ageMs ?? null),
      qualityScore: optionalValue(s.qualityScore, prev?.qualityScore ?? null),
      positionSource: optionalValue(s.positionSource, prev?.positionSource ?? null),
      isMlat: optionalValue(s.isMlat, prev?.isMlat ?? null),
      qualityState,
      receivedAtMs,
      connectionGeneration: this.connectionGeneration,
      ts: s.lastTs,
      tsMs,
    });
    return true;
  }

  private reconcileViewportSnapshot(
    incoming: Set<string>,
    bbox: Bbox,
    generatedAtMs: number,
  ): boolean {
    let changed = false;
    for (const [flightId, sample] of this.map) {
      if (incoming.has(flightId)) continue;
      // `adsb:` rows are supplied by the supplemental global viewport lookup,
      // not by the tracker hot-state snapshot. Keep them until their normal
      // stale lifecycle expires instead of flickering on every WS resubscribe.
      if (flightId.startsWith('adsb:')) continue;
      if (!inBbox(sample.lon, sample.lat, bbox)) continue;
      if (sample.receivedAtMs > generatedAtMs) continue;
      this.map.delete(flightId);
      changed = true;
    }
    return changed;
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

export function classifyFlightSample(
  sample: Pick<FlightSample, 'tsMs'>,
  nowMs: number,
  cfg: FlightLifecycleConfig = CLIENT_FLIGHT_LIFECYCLE,
): FlightQualityState {
  return classifyAge(Math.max(0, nowMs - sample.tsMs), cfg);
}

function classifyAge(ageMs: number, cfg: FlightLifecycleConfig): FlightQualityState {
  if (ageMs <= cfg.liveAfterMs) return 'live';
  if (ageMs <= cfg.delayedAfterMs) return 'delayed';
  if (ageMs <= cfg.staleAfterMs) return 'stale';
  return 'signal_lost';
}

function normalizeQuality(raw: unknown): FlightQualityState | null {
  return typeof raw === 'string' && QUALITY_STATES.has(raw as FlightQualityState)
    ? (raw as FlightQualityState)
    : null;
}

function optionalValue<T>(next: T | null | undefined, fallback: T | null): T | null {
  return next === undefined ? fallback : next;
}

function parseIsoMs(raw: string | undefined): number | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function flightIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const flightId = (raw as { flightId?: unknown }).flightId;
  return typeof flightId === 'string' ? flightId : null;
}

function snapshotScopeOf(raw: unknown): SnapshotScope | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { kind?: unknown; bbox?: unknown; flightId?: unknown };
  if (r.kind === 'viewport' && isBbox(r.bbox)) return { kind: 'viewport', bbox: r.bbox };
  if (r.kind === 'flight' && typeof r.flightId === 'string') {
    return { kind: 'flight', flightId: r.flightId };
  }
  return undefined;
}

function isBbox(raw: unknown): raw is Bbox {
  return Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === 'number');
}

function inBbox(lon: number, lat: number, bbox: Bbox): boolean {
  const [west, south, east, north] = bbox;
  const inLon = west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
  return lat >= south && lat <= north && inLon;
}

/** Route a decoded server message into the store (docs/12 §12.4). */
export function applyServerMessage(store: FlightStore, msg: unknown): void {
  if (typeof msg !== 'object' || msg === null || !('t' in msg)) return;
  const m = msg as {
    t: string;
    id?: unknown;
    channel?: string;
    data?: unknown;
    snapshotId?: string;
    sequence?: number;
    generatedAt?: string;
    scope?: unknown;
    event?: { type?: string; payload?: unknown };
  };

  if (m.t === 'snapshot') {
    store.applySnapshot(m.data, {
      channel: m.channel,
      snapshotId: m.snapshotId,
      sequence: m.sequence,
      generatedAt: m.generatedAt,
      scope: snapshotScopeOf(m.scope),
    });
    return;
  }

  if (m.t !== 'event' || !m.event || !store.markEventSeen(m.id)) return;

  if (m.event.type === 'PositionUpdated') {
    store.applyPosition(m.event.payload as never);
  } else if (m.event.type === 'FlightEnded') {
    const p = m.event.payload as { flightId?: string };
    if (p.flightId) store.remove(p.flightId);
  } else if (
    m.event.type === 'FlightDelayed' ||
    m.event.type === 'FlightStale' ||
    m.event.type === 'FlightSignalLost' ||
    m.event.type === 'FlightRecovered'
  ) {
    const p = m.event.payload as { flightId?: string; state?: string };
    if (p.flightId) store.updateQuality(p.flightId, p.state);
  }
}
