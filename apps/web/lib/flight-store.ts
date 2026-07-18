/**
 * Framework-agnostic live-flight store (docs/12 §12.5). Holds the latest sample
 * per aircraft, guards against out-of-order deltas, and notifies listeners so
 * the map can re-render. Interpolation/animation is the renderer's concern; this
 * store keeps only the authoritative latest samples.
 */
export interface FlightSample {
  flightId: string;
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  heading: number | null;
  altFt: number | null;
  gsKt: number | null;
  onGround: boolean;
  /** Coarse aircraft class (light | jet | heavy | helo) for map icons. */
  category: string | null;
  ts: string;
  tsMs: number;
}

type Listener = () => void;

export class FlightStore {
  private readonly map = new Map<string, FlightSample>();
  private readonly listeners = new Set<Listener>();

  get size(): number {
    return this.map.size;
  }

  list(): FlightSample[] {
    return [...this.map.values()];
  }

  get(flightId: string): FlightSample | undefined {
    return this.map.get(flightId);
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
    lat: number;
    lon: number;
    headingDeg: number | null;
    altFt: number | null;
    gsKt: number | null;
    onGround: boolean;
    ts: string;
  }): boolean {
    const tsMs = Date.parse(p.ts);
    const prev = this.map.get(p.flightId);
    if (prev && tsMs <= prev.tsMs) return false; // out-of-order guard
    this.map.set(p.flightId, {
      flightId: p.flightId,
      icao24: p.icao24,
      callsign: prev?.callsign ?? null,
      lat: p.lat,
      lon: p.lon,
      heading: p.headingDeg,
      altFt: p.altFt,
      gsKt: p.gsKt,
      onGround: p.onGround,
      category: prev?.category ?? null, // static per aircraft; deltas omit it
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
    gsKt: number | null;
    category?: string | null;
    lastTs: string;
  }): void {
    const tsMs = Date.parse(s.lastTs);
    const prev = this.map.get(s.flightId);
    if (prev && tsMs <= prev.tsMs) return;
    this.map.set(s.flightId, {
      flightId: s.flightId,
      icao24: s.icao24,
      callsign: s.callsign ?? prev?.callsign ?? null,
      lat: s.lat,
      lon: s.lon,
      heading: s.headingDeg ?? null,
      altFt: s.altFt,
      gsKt: s.gsKt,
      onGround: false,
      category: s.category ?? prev?.category ?? null,
      ts: s.lastTs,
      tsMs,
    });
    this.emit();
  }

  remove(flightId: string): void {
    if (this.map.delete(flightId)) this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}

/** Route a decoded server message into the store (docs/12 §12.4). */
export function applyServerMessage(store: FlightStore, msg: unknown): void {
  if (typeof msg !== 'object' || msg === null || !('t' in msg)) return;
  const m = msg as { t: string; data?: unknown; event?: { type?: string; payload?: unknown } };

  if (m.t === 'snapshot') {
    if (Array.isArray(m.data)) {
      for (const row of m.data) store.applySnapshotState(row as never);
    } else if (m.data && typeof m.data === 'object' && 'flightId' in m.data) {
      store.applySnapshotState(m.data as never);
    }
    return;
  }

  if (m.t === 'event' && m.event) {
    if (m.event.type === 'PositionUpdated') {
      store.applyPosition(m.event.payload as never);
    } else if (m.event.type === 'FlightEnded') {
      const p = m.event.payload as { flightId?: string };
      if (p.flightId) store.remove(p.flightId);
    }
  }
}
