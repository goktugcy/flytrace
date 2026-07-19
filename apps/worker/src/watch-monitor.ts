import { type Database, sql } from '@flytrace/db';
import {
  type DomainEventInput,
  type EventEnvelope,
  type Logger,
  makeEnvelope,
  systemClock,
} from '@flytrace/shared';

const USER_AGENT = 'FlyTraceWorker/1.0 (+https://flytrace.app; watched flight monitor)';

export interface WatchMonitorOptions {
  apiUrl: string;
  intervalMs: number;
  batchSize: number;
  requestDelayMs: number;
  maxPositionAgeMs: number;
  endAfterMs: number;
}

export interface WatchMonitorDeps {
  db: Database;
  logger: Logger;
  emit: (env: EventEnvelope) => Promise<void>;
  options: WatchMonitorOptions;
  fetchImpl?: typeof fetch;
}

interface WatchedFlight {
  flightId: string;
  callsign: string;
  source: string | null;
  lastPositionAt: string;
  icao24: string;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  squawk: string | null;
  eventCount: number;
  landingCount: number;
  endedCount: number;
}

interface AdsbAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground' | null;
  alt_geom?: number | null;
  gs?: number | null;
  track?: number | null;
  baro_rate?: number | null;
  squawk?: string | null;
  category?: string | null;
  seen_pos?: number | null;
  mlat?: unknown[] | null;
}

interface LivePosition {
  icao24: string;
  callsign: string | null;
  lat: number;
  lon: number;
  altitudeFt: number | null;
  geoAltitudeFt: number | null;
  headingDeg: number | null;
  groundSpeedKt: number | null;
  verticalRateFpm: number | null;
  onGround: boolean;
  squawk: string | null;
  category: string | null;
  ageMs: number;
  ts: string;
  sourceTimestamp: string;
  receivedAt: string;
  positionSource: string;
  isMlat: boolean;
}

export class WatchedFlightMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly deps: WatchMonitorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  start(): void {
    if (this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.deps.options.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const flights = await this.loadWatchedFlights();
      let emitted = 0;
      for (const flight of flights) {
        emitted += await this.handleFlight(flight);
        if (this.deps.options.requestDelayMs > 0) {
          await sleep(this.deps.options.requestDelayMs);
        }
      }
      return emitted;
    } catch (err) {
      this.deps.logger.error('watch monitor failed', { err: String(err) });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async loadWatchedFlights(): Promise<WatchedFlight[]> {
    return (await this.deps.db.execute(sql`
      select distinct on (f.id)
             f.id as "flightId", f.callsign, f.source,
             p.ts as "lastPositionAt", p.icao24,
             ST_Y(p.location::geometry) as lat, ST_X(p.location::geometry) as lon,
             p.altitude_ft as "altitudeFt", p.heading_deg as "headingDeg",
             p.ground_speed_kt as "groundSpeedKt", p.vertical_rate_fpm as "verticalRateFpm",
             p.on_ground as "onGround", p.squawk,
             (select count(*)::int from flight_events e where e.flight_id = f.id) as "eventCount",
             (select count(*)::int from flight_events e where e.flight_id = f.id and e.type = 'landing') as "landingCount",
             (select count(*)::int from flight_events e where e.flight_id = f.id and e.type = 'flight_ended') as "endedCount"
      from watchlist_items w
      join flights f on f.id = w.flight_id
      join lateral (
        select *
        from flight_positions fp
        where fp.flight_id = f.id and fp.icao24 is not null
        order by fp.ts desc
        limit 1
      ) p on true
      where w.active = true
        and w.deleted_at is null
        and f.status = 'active'
      order by f.id, w.created_at desc
      limit ${this.deps.options.batchSize}
    `)) as unknown as WatchedFlight[];
  }

  private async handleFlight(flight: WatchedFlight): Promise<number> {
    let emitted = 0;
    if (flight.eventCount === 0) {
      await this.emit(flightDetectedEvent(flight));
      emitted += 1;
    }

    const live = await this.fetchLive(flight.icao24);
    if (!live) {
      if (shouldEndFromTimeout(flight, this.deps.options.endAfterMs)) {
        await this.emit(flightEndedEvent(flight, 'timeout', systemClock.nowIso()));
        emitted += 1;
      }
      return emitted;
    }

    if (Date.parse(live.ts) > Date.parse(flight.lastPositionAt)) {
      await this.emit(positionUpdatedEvent(flight, live));
      emitted += 1;
    }

    if (!flight.onGround && live.onGround && flight.landingCount === 0) {
      await this.emit(landingEvent(flight, live));
      await this.emit(flightEndedEvent(flight, 'landed', live.ts));
      emitted += 2;
    }

    return emitted;
  }

  private async fetchLive(icao24: string): Promise<LivePosition | null> {
    const hex = icao24.trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) return null;
    try {
      const res = await this.fetchImpl(
        `${this.deps.options.apiUrl.replace(/\/+$/, '')}/hex/${hex}`,
        {
          headers: { accept: 'application/json', 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (!res.ok) return null;
      const aircraft = ((await res.json()) as { ac?: AdsbAircraft[] }).ac ?? [];
      const nowMs = systemClock.now();
      for (const raw of aircraft) {
        const live = livePositionFromAdsb(raw, nowMs);
        if (live?.icao24 === hex && live.ageMs <= this.deps.options.maxPositionAgeMs) return live;
      }
    } catch (err) {
      this.deps.logger.warn('watch monitor ADS-B lookup failed', { icao24: hex, err: String(err) });
    }
    return null;
  }

  private async emit(input: DomainEventInput): Promise<void> {
    await this.deps.emit(makeEnvelope(input, { producer: 'worker', clock: systemClock }));
  }
}

function flightDetectedEvent(flight: WatchedFlight): DomainEventInput {
  const firstSeenAt = isoTime(flight.lastPositionAt);
  return {
    type: 'FlightDetected',
    occurredAt: firstSeenAt,
    dedupeKey: `${flight.flightId}:detected`,
    partitionKey: flight.flightId,
    payload: {
      flightId: flight.flightId,
      icao24: flight.icao24,
      callsign: flight.callsign,
      firstPosition: { lat: flight.lat, lon: flight.lon, ts: firstSeenAt },
      source: flight.source ?? 'adsb',
    },
  };
}

function positionUpdatedEvent(flight: WatchedFlight, live: LivePosition): DomainEventInput {
  return {
    type: 'PositionUpdated',
    occurredAt: live.ts,
    dedupeKey: `${flight.flightId}:watched:pos:${live.ts}`,
    partitionKey: flight.flightId,
    payload: {
      flightId: flight.flightId,
      icao24: live.icao24,
      lat: live.lat,
      lon: live.lon,
      altFt: live.altitudeFt,
      geoAltitudeFt: live.geoAltitudeFt,
      headingDeg: live.headingDeg,
      gsKt: live.groundSpeedKt,
      vrateFpm: live.verticalRateFpm,
      onGround: live.onGround,
      squawk: live.squawk,
      ts: live.ts,
      callsign: live.callsign ?? flight.callsign,
      category: live.category,
      source: 'adsb-watch',
      qualityState: 'live',
      sourceTimestamp: live.sourceTimestamp,
      receivedAt: live.receivedAt,
      ageMs: live.ageMs,
      positionSource: live.positionSource,
      isMlat: live.isMlat,
    },
  };
}

function landingEvent(flight: WatchedFlight, live: LivePosition): DomainEventInput {
  return {
    type: 'LandingDetected',
    occurredAt: live.ts,
    dedupeKey: `${flight.flightId}:watched:landing`,
    partitionKey: flight.flightId,
    payload: {
      flightId: flight.flightId,
      icao24: live.icao24,
      callsign: live.callsign ?? flight.callsign,
      at: live.ts,
      lat: live.lat,
      lon: live.lon,
      altFt: live.altitudeFt,
      confidence: 0.8,
      source: 'adsb-watch',
    },
  };
}

function flightEndedEvent(
  flight: Pick<WatchedFlight, 'flightId' | 'icao24' | 'callsign'>,
  reason: 'landed' | 'timeout',
  endedAt: string,
): DomainEventInput {
  return {
    type: 'FlightEnded',
    occurredAt: endedAt,
    dedupeKey: `${flight.flightId}:watched:ended`,
    partitionKey: flight.flightId,
    payload: {
      flightId: flight.flightId,
      icao24: flight.icao24,
      callsign: flight.callsign,
      endedAt,
      reason,
    },
  };
}

function shouldEndFromTimeout(flight: WatchedFlight, endAfterMs: number): boolean {
  if (flight.endedCount > 0) return false;
  const lastMs = Date.parse(flight.lastPositionAt);
  return Number.isFinite(lastMs) && systemClock.now() - lastMs >= endAfterMs;
}

function isoTime(value: string): string {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : systemClock.nowIso();
}

function livePositionFromAdsb(raw: AdsbAircraft, nowMs: number): LivePosition | null {
  const icao24 = typeof raw.hex === 'string' ? raw.hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(icao24)) return null;
  if (!finite(raw.lat) || !finite(raw.lon)) return null;
  const ageMs = finite(raw.seen_pos) ? Math.max(0, Math.round(raw.seen_pos * 1000)) : 0;
  const ts = new Date(nowMs - ageMs).toISOString();
  const onGround = raw.alt_baro === 'ground';
  const isMlat = Array.isArray(raw.mlat) && raw.mlat.length > 0;
  return {
    icao24,
    callsign: typeof raw.flight === 'string' ? raw.flight.trim() || null : null,
    lat: raw.lat,
    lon: raw.lon,
    altitudeFt: finite(raw.alt_baro) ? Math.round(raw.alt_baro) : onGround ? 0 : null,
    geoAltitudeFt: finite(raw.alt_geom) ? Math.round(raw.alt_geom) : null,
    headingDeg: finite(raw.track) ? Math.round(raw.track * 10) / 10 : null,
    groundSpeedKt: finite(raw.gs) ? Math.round(raw.gs * 10) / 10 : null,
    verticalRateFpm: finite(raw.baro_rate) ? Math.round(raw.baro_rate) : null,
    onGround,
    squawk: typeof raw.squawk === 'string' ? raw.squawk : null,
    category: adsbCategory(raw.category),
    ageMs,
    ts,
    sourceTimestamp: ts,
    receivedAt: new Date(nowMs).toISOString(),
    positionSource: isMlat ? 'mlat' : 'adsb',
    isMlat,
  };
}

function adsbCategory(cat: string | null | undefined): string | null {
  switch ((cat ?? '').toUpperCase()) {
    case 'A1':
    case 'A2':
    case 'B4':
      return 'light';
    case 'A5':
      return 'heavy';
    case 'A7':
      return 'helo';
    case 'A3':
    case 'A4':
    case 'A6':
      return 'jet';
    default:
      return null;
  }
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
