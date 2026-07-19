import {
  type FlightRow,
  type SearchResultRow,
  createCatalogRepo,
  createFlightReadRepo,
  createFlightStatusRepo,
} from '@flytrace/db';
import { AppError, type FlightDetail, type LiveFlight } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import { type Bbox, inBbox } from '../ws/channels.ts';
import { createHotState } from './hot-state.ts';

const PLANESPOTTERS_UA = 'FlyTrace/1.0 (+https://flytrace.app; live flight tracker)';
const PHOTO_TTL_MS = 6 * 60 * 60 * 1000; // 6h — tail photos rarely change

interface PlanespottersPhoto {
  thumbnail?: { src?: string };
  thumbnail_large?: { src?: string };
  link?: string;
  photographer?: string;
}
type AircraftPhoto = {
  thumb: string | null;
  link: string | null;
  photographer: string | null;
} | null;
const photoCache = new Map<string, { photo: AircraftPhoto; exp: number }>();

const ADSBDB_UA = 'FlyTrace/1.0 (+https://flytrace.app; live flight tracker)';
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000; // 6h — routes are static per callsign

interface AdsbdbAirport {
  iata_code?: string;
  name?: string;
  municipality?: string;
  latitude?: number;
  longitude?: number;
}
interface FlightRoute {
  airline: string | null;
  origin: { iata: string; name: string; city: string | null; lat: number; lon: number };
  destination: { iata: string; name: string; city: string | null; lat: number; lon: number };
}
const routeCache = new Map<string, { route: FlightRoute | null; exp: number }>();

// adsb.lol callsign lookup — keyless. Used as a search fallback so a flight
// that isn't in our DB yet is still located from the live feed.
const ADSB_CALLSIGN_URL = 'https://api.adsb.lol/v2/callsign/';
interface AdsbAircraft {
  hex?: string;
  flight?: string;
  lat?: number;
  lon?: number;
}

const ADSB_LIVE_API_URL = (process.env.ADSB_API_URL ?? 'https://api.adsb.lol/v2').replace(
  /\/+$/,
  '',
);
const ADSB_VIEWPORT_TTL_MS = 5_000;
const ADSB_VIEWPORT_MAX_RADIUS_NM = 250;
const ADSB_VIEWPORT_MIN_RADIUS_NM = 8;
const ADSB_VIEWPORT_FRESH_MS = 90_000;

interface AdsbViewportAircraft extends AdsbAircraft {
  alt_baro?: number | 'ground' | null;
  alt_geom?: number | null;
  gs?: number | null;
  track?: number | null;
  baro_rate?: number | null;
  squawk?: string | null;
  category?: string | null;
  mlat?: unknown[] | null;
  seen_pos?: number | null;
}

interface ViewportLiveLookup {
  flights: LiveFlight[];
  center: { lat: number; lon: number };
  radiusNm: number;
  clipped: boolean;
}

const viewportLiveCache = new Map<string, { exp: number; value: ViewportLiveLookup }>();

function toEndpoint(a: AdsbdbAirport): FlightRoute['origin'] | null {
  if (typeof a.latitude !== 'number' || typeof a.longitude !== 'number') return null;
  return {
    iata: a.iata_code ?? '',
    name: a.name ?? '',
    city: a.municipality ?? null,
    lat: a.latitude,
    lon: a.longitude,
  };
}

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const bboxSchema = z.string().transform((v, ctx) => {
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be "w,s,e,n"' });
    return z.NEVER;
  }
  return parts as [number, number, number, number];
});

/**
 * Public flight read endpoints (docs/11 §11.6). Live reads come from Redis hot
 * state (meta.cached=true); detail/track/timeline from Postgres (what the
 * worker persisted). Validation via Zod; misses raise a typed AppError that the
 * app's error mapper renders into the standard envelope.
 */
export function createFlightsRoutes(ctx: AppContext): Hono<AppEnv> {
  const read = createFlightReadRepo(ctx.db);
  const catalog = createCatalogRepo(ctx.db);
  const statusRead = createFlightStatusRepo(ctx.db);
  const hot = createHotState(ctx.redis, ctx.redisPrefix);

  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown, cached = false) =>
    c.json({ data, meta: { requestId: c.get('requestId'), cached } });

  // Aircraft photo proxy (Planespotters). Server-side so we can send the
  // contact User-Agent their API requires; short in-memory cache to stay polite.
  app.get('/aircraft-photo/:hex', async (c) => {
    const hex = (c.req.param('hex') ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(hex)) throw new AppError('BAD_REQUEST', 'hex must be 6 hex digits');
    const cached = photoCache.get(hex);
    if (cached && cached.exp > Date.now()) return ok(c, { photo: cached.photo }, true);
    let photo: AircraftPhoto = null;
    try {
      const res = await fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
        headers: { accept: 'application/json', 'user-agent': PLANESPOTTERS_UA },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const body = (await res.json()) as { photos?: PlanespottersPhoto[] };
        const p = body.photos?.[0];
        if (p) {
          photo = {
            thumb: p.thumbnail_large?.src ?? p.thumbnail?.src ?? null,
            link: p.link ?? null,
            photographer: p.photographer ?? null,
          };
        }
      }
    } catch {
      /* no photo — degrade gracefully */
    }
    photoCache.set(hex, { photo, exp: Date.now() + PHOTO_TTL_MS });
    return ok(c, { photo });
  });

  // Flight route (origin/destination airports) by callsign, via adsbdb —
  // keyless, cached; the ADS-B feed itself carries no route.
  app.get('/flights/route/:callsign', async (c) => {
    const cs = (c.req.param('callsign') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) throw new AppError('BAD_REQUEST', 'invalid callsign');
    const cached = routeCache.get(cs);
    if (cached && cached.exp > Date.now()) return ok(c, { route: cached.route }, true);
    let route: FlightRoute | null = null;
    try {
      const res = await fetch(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`, {
        headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const fr = (
          (await res.json()) as {
            response?: {
              flightroute?: {
                origin?: AdsbdbAirport;
                destination?: AdsbdbAirport;
                airline?: { name?: string };
              };
            };
          }
        ).response?.flightroute;
        const origin = fr?.origin ? toEndpoint(fr.origin) : null;
        const destination = fr?.destination ? toEndpoint(fr.destination) : null;
        if (origin && destination)
          route = { airline: fr?.airline?.name ?? null, origin, destination };
      }
    } catch {
      /* no route — degrade gracefully */
    }
    routeCache.set(cs, { route, exp: Date.now() + ROUTE_TTL_MS });
    return ok(c, { route });
  });

  // Live flights in a viewport (map bootstrap) — Redis hot path.
  app.get('/flights/live', async (c) => {
    const raw = c.req.query('bbox');
    let bbox: Bbox | undefined;
    if (raw !== undefined) {
      const parsed = bboxSchema.safeParse(raw);
      if (!parsed.success)
        throw new AppError('BAD_REQUEST', 'invalid bbox', { details: parsed.error.issues });
      bbox = parsed.data;
    }
    const flights = await hot.live(bbox);
    return ok(c, { flights, count: flights.length }, true);
  });

  // Live flights for the current map viewport. The persistent tracker can only
  // ingest a bounded area; this endpoint widens browsing coverage by fetching
  // the visible region on demand from adsb.lol and merging it with Redis.
  app.get('/flights/live/viewport', async (c) => {
    const raw = c.req.query('bbox');
    if (raw === undefined) throw new AppError('BAD_REQUEST', 'bbox is required');
    const parsed = bboxSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError('BAD_REQUEST', 'invalid bbox', { details: parsed.error.issues });
    const bbox = clampBbox(parsed.data);

    const cachedFlights = await hot.live(bbox).catch((err) => {
      ctx.logger.warn('viewport live hot state unavailable', { err: String(err) });
      return [] as LiveFlight[];
    });

    let lookup: ViewportLiveLookup | null = null;
    try {
      lookup = await lookupViewportLive(bbox, ctx.clock.now());
    } catch (err) {
      ctx.logger.warn('viewport ADS-B lookup unavailable', { bbox, err: String(err) });
    }

    const byIcao = new Set(cachedFlights.map((f) => f.icao24.toLowerCase()));
    const flights = [...cachedFlights];
    if (lookup) {
      for (const f of lookup.flights) {
        if (byIcao.has(f.icao24.toLowerCase())) continue;
        byIcao.add(f.icao24.toLowerCase());
        flights.push(f);
      }
    }

    return ok(c, {
      flights,
      count: flights.length,
      viewport: lookup
        ? { center: lookup.center, radiusNm: lookup.radiusNm, clipped: lookup.clipped }
        : null,
    });
  });

  // Typeahead search over flights (callsign / flight number). OpenSky stores
  // ICAO callsigns (THY281); if the query looks like an IATA flight number
  // (TK281), resolve the airline's ICAO prefix and search that variant too.
  app.get('/flights/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 1) return ok(c, { results: [] });
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 50);

    let altTerm: string | undefined;
    const iata = q.match(/^([A-Za-z]{2})\s?(\d{1,4})$/);
    if (iata) {
      const icao = await catalog.getIcaoByIata(iata[1] as string);
      if (icao) altTerm = `${icao}${iata[2]}`;
    }
    const results = await read.search(q, limit, altTerm);

    // Partial DB matches (ilike '%THY1%' → THY1DU…) must NOT suppress the live
    // lookup for the *exact* callsign the user typed. So whenever the query
    // looks like a complete callsign and no DB row matches it exactly, resolve
    // it live on adsb.lol and surface it at the top. No persistent row is
    // created; the ADS-B feed carries the position for the map to locate it.
    const norm = (altTerm ?? q).replace(/\s+/g, '').toUpperCase();
    const looksComplete = /^[A-Z]{2,3}\d{1,4}[A-Z]?$/.test(norm) || /^[A-Z0-9]{5,8}$/.test(norm);
    const hasExact = results.some((r) => r.callsign.toUpperCase() === norm);
    if (looksComplete && !hasExact) {
      const live = await lookupLiveCallsign(norm);
      if (live && !results.some((r) => r.icao24 === live.icao24)) {
        results.unshift({ ...live, flightDate: ctx.clock.nowIso().slice(0, 10) });
      }
    }
    return ok(c, { results });
  });

  // Landing-page live counters.
  app.get('/stats/live', async (c) => {
    const [flightsLive, eventsToday] = await Promise.all([hot.count(), read.countEventsToday()]);
    return ok(c, { flightsLive, eventsToday }, true);
  });

  const detailFor = async (flight: FlightRow): Promise<FlightDetail> => {
    const [dbLive, hotLive, events, statusSnapshot] = await Promise.all([
      read.getLatestPosition(flight.id),
      hot.get(flight.id).catch((err) => {
        ctx.logger.warn('flight detail hot state unavailable', {
          flightId: flight.id,
          err: String(err),
        });
        return null;
      }),
      read.getEvents(flight.id),
      statusRead.getSnapshot(flight.id),
    ]);
    const persistedLive: FlightDetail['live'] = dbLive
      ? {
          lat: dbLive.lat,
          lon: dbLive.lon,
          altitudeFt: dbLive.altitudeFt,
          geoAltitudeFt: dbLive.geoAltitudeFt,
          headingDeg: dbLive.headingDeg,
          groundSpeedKt: dbLive.groundSpeedKt,
          verticalRateFpm: dbLive.verticalRateFpm,
          onGround: dbLive.onGround,
          squawk: dbLive.squawk,
          source: dbLive.source,
          ts: dbLive.ts,
        }
      : null;
    const live: FlightDetail['live'] = hotLive ? detailLiveFromHot(hotLive) : persistedLive;
    return {
      flight: {
        flightId: flight.id,
        callsign: flight.callsign,
        flightNumber: flight.flightNumber,
        status: flight.status,
        flightDate: flight.flightDate,
        source: flight.source,
      },
      live,
      statusSnapshot,
      timeline: events.map((e) => ({
        type: e.type,
        occurredAt: e.occurredAt,
        confidence: e.confidence,
        source: e.source,
      })),
    };
  };

  const detailForLive = (live: LiveFlight): FlightDetail => ({
    flight: {
      flightId: live.flightId,
      callsign: live.callsign ?? live.icao24.toUpperCase(),
      flightNumber: null,
      status: 'active',
      flightDate: live.ts.slice(0, 10),
      source: live.source ?? 'adsb',
    },
    live: detailLiveFromHot(live),
    statusSnapshot: null,
    timeline: [],
  });

  // By flightId (map/WS use uuids) — static `id` segment precedes :callsign.
  app.get('/flights/id/:flightId', async (c) => {
    const flightId = decodePathParam(c.req.param('flightId'));
    if (flightId.startsWith('adsb:')) {
      const icao24 = flightId.slice('adsb:'.length).toLowerCase();
      const live = await lookupLiveIcao(icao24, ctx.clock.now());
      if (!live) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
      return ok(c, detailForLive(live), true);
    }

    const flight = await read.getFlightById(flightId);
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
    return ok(c, await detailFor(flight));
  });

  app.get('/flights/id/:flightId/track', async (c) => {
    const flightId = decodePathParam(c.req.param('flightId'));
    if (flightId.startsWith('adsb:')) return ok(c, { flightId, points: [], count: 0 }, true);
    const flight = await read.getFlightById(flightId);
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
    const limit = Math.min(Number(c.req.query('limit') ?? 5000) || 5000, 10_000);
    const points = await read.getTrack(flight.id, limit);
    return ok(c, { flightId: flight.id, points, count: points.length });
  });

  app.get('/flights/id/:flightId/events', async (c) => {
    const flightId = decodePathParam(c.req.param('flightId'));
    if (flightId.startsWith('adsb:')) return ok(c, { flightId, events: [] }, true);
    const flight = await read.getFlightById(flightId);
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
    return ok(c, { flightId: flight.id, events: await read.getEvents(flight.id) });
  });

  // Full flight detail by natural key.
  app.get('/flights/:callsign/:date', async (c) => {
    const { flight } = await requireFlight(c, read);
    return ok(c, await detailFor(flight));
  });

  // Position track (ascending). Downsampling is a later optimization.
  app.get('/flights/:callsign/:date/track', async (c) => {
    const { flight } = await requireFlight(c, read);
    const limit = Math.min(Number(c.req.query('limit') ?? 5000) || 5000, 10_000);
    const points = await read.getTrack(flight.id, limit);
    return ok(c, { flightId: flight.id, points, count: points.length });
  });

  // Derived + provider event timeline.
  app.get('/flights/:callsign/:date/events', async (c) => {
    const { flight } = await requireFlight(c, read);
    const events = await read.getEvents(flight.id);
    return ok(c, { flightId: flight.id, events });
  });

  return app;
}

function detailLiveFromHot(live: LiveFlight): NonNullable<FlightDetail['live']> {
  return {
    flightId: live.flightId,
    icao24: live.icao24,
    callsign: live.callsign,
    lat: live.lat,
    lon: live.lon,
    altitudeFt: live.altitudeFt,
    ...(live.geoAltitudeFt !== undefined ? { geoAltitudeFt: live.geoAltitudeFt } : {}),
    headingDeg: live.headingDeg,
    groundSpeedKt: live.groundSpeedKt,
    verticalRateFpm: live.verticalRateFpm ?? null,
    onGround: live.onGround,
    ...(live.squawk !== undefined ? { squawk: live.squawk } : {}),
    ...(live.category !== undefined ? { category: live.category } : {}),
    ...(live.qualityState !== undefined ? { qualityState: live.qualityState } : {}),
    ...(live.source !== undefined ? { source: live.source } : {}),
    ...(live.sourceTimestamp !== undefined ? { sourceTimestamp: live.sourceTimestamp } : {}),
    ...(live.receivedAt !== undefined ? { receivedAt: live.receivedAt } : {}),
    ...(live.ageMs !== undefined ? { ageMs: live.ageMs } : {}),
    ...(live.qualityScore !== undefined ? { qualityScore: live.qualityScore } : {}),
    ...(live.positionSource !== undefined ? { positionSource: live.positionSource } : {}),
    ...(live.isMlat !== undefined ? { isMlat: live.isMlat } : {}),
    ts: live.ts,
  };
}

function clampBbox([west, south, east, north]: Bbox): Bbox {
  if (![west, south, east, north].every(Number.isFinite) || south >= north) {
    throw new AppError('BAD_REQUEST', 'invalid bbox');
  }
  const clampedSouth = Math.max(-90, Math.min(90, south));
  const clampedNorth = Math.max(-90, Math.min(90, north));
  if (clampedSouth >= clampedNorth) throw new AppError('BAD_REQUEST', 'invalid bbox');
  const height = Math.abs(north - south);
  const rawWidth = Math.abs(east - west);
  if (rawWidth >= 360 || height >= 180) {
    return [-180, clampedSouth, 180, clampedNorth];
  }
  return [wrapLon(west), clampedSouth, wrapLon(east), clampedNorth];
}

async function lookupViewportLive(bbox: Bbox, nowMs: number): Promise<ViewportLiveLookup> {
  const viewport = viewportCircle(bbox);
  const key = [
    Math.round(viewport.center.lat * 20) / 20,
    Math.round(viewport.center.lon * 20) / 20,
    Math.ceil(viewport.radiusNm / 10) * 10,
  ].join(':');
  const cached = viewportLiveCache.get(key);
  if (cached && cached.exp > nowMs) return cached.value;

  const url = `${ADSB_LIVE_API_URL}/lat/${viewport.center.lat.toFixed(5)}/lon/${viewport.center.lon.toFixed(5)}/dist/${viewport.radiusNm}`;
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`adsb viewport failed: ${res.status}`);

  const raw = ((await res.json()) as { ac?: AdsbViewportAircraft[] }).ac ?? [];
  const flights: LiveFlight[] = [];
  const seenIcao = new Set<string>();
  for (const ac of raw) {
    const flight = liveFlightFromAdsb(ac, nowMs);
    if (!flight || !inBbox(flight.lat, flight.lon, bbox)) continue;
    if (seenIcao.has(flight.icao24)) continue;
    seenIcao.add(flight.icao24);
    flights.push(flight);
  }

  const value = { flights, ...viewport };
  viewportLiveCache.set(key, { exp: nowMs + ADSB_VIEWPORT_TTL_MS, value });
  trimViewportCache(nowMs);
  return value;
}

function liveFlightFromAdsb(a: AdsbViewportAircraft, nowMs: number): LiveFlight | null {
  const icao24 = typeof a.hex === 'string' ? a.hex.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{6}$/.test(icao24)) return null;
  if (!finiteNumber(a.lat) || !finiteNumber(a.lon)) return null;
  const seenPosMs = finiteNumber(a.seen_pos) ? Math.max(0, a.seen_pos * 1000) : 0;
  if (seenPosMs > ADSB_VIEWPORT_FRESH_MS) return null;

  const onGround = a.alt_baro === 'ground';
  const ts = new Date(nowMs - seenPosMs).toISOString();
  const isMlat = Array.isArray(a.mlat) && a.mlat.length > 0;
  const callsign = typeof a.flight === 'string' ? a.flight.trim() || null : null;
  const altitudeFt = finiteNumber(a.alt_baro) ? Math.round(a.alt_baro) : onGround ? 0 : null;
  const headingDeg = finiteNumber(a.track) ? normalizeHeading(a.track) : null;
  const groundSpeedKt = finiteNumber(a.gs) ? round(a.gs, 1) : null;

  return {
    flightId: `adsb:${icao24}`,
    icao24,
    callsign,
    lat: a.lat,
    lon: a.lon,
    altitudeFt,
    geoAltitudeFt: finiteNumber(a.alt_geom) ? Math.round(a.alt_geom) : null,
    headingDeg,
    groundSpeedKt,
    verticalRateFpm: finiteNumber(a.baro_rate) ? Math.round(a.baro_rate) : null,
    onGround,
    squawk: typeof a.squawk === 'string' ? a.squawk : null,
    category: adsbCategory(a.category),
    qualityState: qualityStateForAge(seenPosMs),
    source: 'adsb',
    sourceTimestamp: ts,
    ageMs: Math.round(seenPosMs),
    qualityScore: qualityScoreForAge(seenPosMs),
    positionSource: isMlat ? 'mlat' : 'adsb',
    isMlat,
    receivedAt: new Date(nowMs).toISOString(),
    ts,
  };
}

function viewportCircle(bbox: Bbox): Omit<ViewportLiveLookup, 'flights'> {
  const [west, south, east, north] = bbox;
  const center = {
    lat: (south + north) / 2,
    lon: west <= east ? (west + east) / 2 : wrapLon((west + east + 360) / 2),
  };
  const corners: [number, number][] = [
    [west, south],
    [west, north],
    [east, south],
    [east, north],
  ];
  const neededRadius = Math.ceil(
    Math.max(...corners.map(([lon, lat]) => distanceNm(center.lat, center.lon, lat, lon))) + 20,
  );
  const radiusNm = Math.min(
    ADSB_VIEWPORT_MAX_RADIUS_NM,
    Math.max(ADSB_VIEWPORT_MIN_RADIUS_NM, neededRadius),
  );
  return { center, radiusNm, clipped: neededRadius > ADSB_VIEWPORT_MAX_RADIUS_NM };
}

function trimViewportCache(nowMs: number): void {
  if (viewportLiveCache.size <= 200) return;
  for (const [key, cached] of viewportLiveCache) {
    if (cached.exp <= nowMs) viewportLiveCache.delete(key);
  }
  while (viewportLiveCache.size > 200) {
    const oldest = viewportLiveCache.keys().next().value as string | undefined;
    if (!oldest) break;
    viewportLiveCache.delete(oldest);
  }
}

function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rNm = 3440.065;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * rNm * Math.asin(Math.min(1, Math.sqrt(a)));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

function normalizeHeading(deg: number): number {
  return Math.round((((deg % 360) + 360) % 360) * 10) / 10;
}

function finiteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function round(n: number, dp = 0): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function qualityStateForAge(ageMs: number): NonNullable<LiveFlight['qualityState']> {
  if (ageMs <= 15_000) return 'live';
  if (ageMs <= 30_000) return 'delayed';
  if (ageMs <= 60_000) return 'stale';
  return 'signal_lost';
}

function qualityScoreForAge(ageMs: number): number {
  return round(Math.max(0, Math.min(1, 1 - ageMs / ADSB_VIEWPORT_FRESH_MS)), 2);
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

function decodePathParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Look up a callsign on the live adsb.lol feed and shape it like a search
 * result (id prefixed `adsb:` so the client knows it's a live, unpersisted
 * hit). Returns null when the callsign isn't currently airborne.
 */
async function lookupLiveCallsign(
  callsign: string,
): Promise<Omit<SearchResultRow, 'flightDate'> | null> {
  const cs = callsign.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,8}$/.test(cs)) return null;
  try {
    const res = await fetch(`${ADSB_CALLSIGN_URL}${encodeURIComponent(cs)}`, {
      headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const ac = ((await res.json()) as { ac?: AdsbAircraft[] }).ac ?? [];
    const hit = ac.find((a) => typeof a.lat === 'number' && typeof a.lon === 'number');
    if (!hit?.hex) return null;
    return {
      flightId: `adsb:${hit.hex.toLowerCase()}`,
      callsign: (hit.flight ?? cs).trim(),
      flightNumber: null,
      status: 'active',
      icao24: hit.hex.toLowerCase(),
      lat: hit.lat as number,
      lon: hit.lon as number,
    };
  } catch {
    return null;
  }
}

async function lookupLiveIcao(icao24: string, nowMs: number): Promise<LiveFlight | null> {
  const hex = icao24.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) throw new AppError('BAD_REQUEST', 'hex must be 6 hex digits');
  try {
    const res = await fetch(`${ADSB_LIVE_API_URL}/hex/${encodeURIComponent(hex)}`, {
      headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const ac = ((await res.json()) as { ac?: AdsbViewportAircraft[] }).ac ?? [];
    for (const raw of ac) {
      const live = liveFlightFromAdsb(raw, nowMs);
      if (live?.icao24 === hex) return live;
    }
    return null;
  } catch (err) {
    if (err instanceof AppError) throw err;
    return null;
  }
}

async function requireFlight(c: Context<AppEnv>, read: ReturnType<typeof createFlightReadRepo>) {
  const callsign = c.req.param('callsign');
  if (!callsign) throw new AppError('BAD_REQUEST', 'callsign is required');
  const dateParsed = dateSchema.safeParse(c.req.param('date'));
  if (!dateParsed.success) {
    throw new AppError('BAD_REQUEST', 'invalid date', { details: dateParsed.error.issues });
  }
  const flight = await read.getFlight(callsign, dateParsed.data);
  if (!flight)
    throw new AppError('FLIGHT_NOT_FOUND', `flight ${callsign} on ${dateParsed.data} not found`);
  return { flight };
}
