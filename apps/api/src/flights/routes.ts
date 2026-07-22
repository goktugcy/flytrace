import {
  type FlightRow,
  type SearchResultRow,
  createCatalogReadRepo,
  createCatalogRepo,
  createFlightReadRepo,
  createFlightRepo,
  createFlightStatusRepo,
  sql,
} from '@flytrace/db';
import { AppError, type FlightDetail, type LiveFlight, uuidv7 } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import { requireUser } from '../auth/routes.ts';
import type { AppContext } from '../context.ts';
import { type Bbox, inBbox } from '../ws/channels.ts';
import { createHotState } from './hot-state.ts';
import { FlightRouteResolver } from './route-resolver.ts';

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
const ADSB_VIEWPORT_TTL_MS = 15_000;
const ADSB_VIEWPORT_MAX_RADIUS_NM = 250;
const ADSB_VIEWPORT_MIN_RADIUS_NM = 8;
const ADSB_VIEWPORT_FRESH_MS = 90_000;
const ADSB_DETAIL_TTL_MS = 2 * 60 * 1000;
const PROMOTED_FLIGHT_REUSE_MS = 6 * 60 * 60 * 1000;

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
const liveByIcaoCache = new Map<string, { exp: number; value: LiveFlight }>();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
const routeObservationSchema = z
  .object({
    flightId: z.string().min(1).max(80).optional(),
    icao24: z
      .string()
      .regex(/^[0-9a-fA-F]{6}$/)
      .optional(),
    date: dateSchema.optional(),
    lat: z.coerce.number().min(-90).max(90).optional(),
    lon: z.coerce.number().min(-180).max(180).optional(),
    headingDeg: z.coerce.number().min(0).max(360).optional(),
    onGround: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
    ts: z.string().datetime().optional(),
  })
  .refine((value) => (value.lat == null) === (value.lon == null), {
    message: 'lat and lon must be supplied together',
  });
const bboxSchema = z.string().transform((v, ctx) => {
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be "w,s,e,n"' });
    return z.NEVER;
  }
  return parts as [number, number, number, number];
});
const nullableNumberSchema = z.number().nullable().optional();
const promoteLiveSchema = z
  .object({
    flightId: z.string().optional(),
    icao24: z
      .string()
      .regex(/^[0-9a-fA-F]{6}$/)
      .optional(),
    snapshot: z
      .object({
        flightId: z.string().optional(),
        icao24: z.string().regex(/^[0-9a-fA-F]{6}$/),
        callsign: z.string().nullable().optional(),
        lat: z.number(),
        lon: z.number(),
        altitudeFt: nullableNumberSchema,
        geoAltitudeFt: nullableNumberSchema,
        headingDeg: nullableNumberSchema,
        groundSpeedKt: nullableNumberSchema,
        verticalRateFpm: nullableNumberSchema,
        onGround: z.boolean().optional(),
        squawk: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        qualityState: z.string().optional(),
        source: z.string().nullable().optional(),
        sourceTimestamp: z.string().optional(),
        ageMs: z.number().optional(),
        qualityScore: z.number().optional(),
        positionSource: z.string().optional(),
        isMlat: z.boolean().optional(),
        receivedAt: z.string().optional(),
        ts: z.string(),
      })
      .optional(),
  })
  .refine((v) => v.snapshot || v.icao24 || v.flightId?.startsWith('adsb:'), {
    message: 'snapshot, icao24 or adsb flightId is required',
  });
const liveTrackSeedSchema = z.object({
  flights: z
    .array(
      z.object({
        flightId: z.string().min(1),
        icao24: z
          .string()
          .regex(/^[0-9a-fA-F]{6}$/)
          .optional(),
        callsign: z.string().trim().min(2).max(12).nullable().optional(),
        ts: z.string().datetime().optional(),
      }),
    )
    .max(250),
  limitPerFlight: z.coerce.number().int().positive().max(240).default(90),
  sinceMinutes: z.coerce
    .number()
    .int()
    .positive()
    .max(24 * 60)
    .default(12 * 60),
});

interface LiveTrackSeedRow {
  requestKey: string;
  transientFlightId: string | null;
  flightId: string;
  ts: string;
  icao24: string | null;
  lat: number | null;
  lon: number | null;
  altitudeFt: number | null;
  headingDeg: number | null;
}

interface LiveTrackSeedPoint {
  ts: string;
  icao24: string | null;
  lat: number | null;
  lon: number | null;
  altitudeFt: number | null;
  headingDeg: number | null;
}

/**
 * Public flight read endpoints (docs/11 §11.6). Live reads come from Redis hot
 * state (meta.cached=true); detail/track/timeline from Postgres (what the
 * worker persisted). Validation via Zod; misses raise a typed AppError that the
 * app's error mapper renders into the standard envelope.
 */
export function createFlightsRoutes(ctx: AppContext): Hono<AppEnv> {
  const read = createFlightReadRepo(ctx.db);
  const write = createFlightRepo(ctx.db);
  const catalog = createCatalogRepo(ctx.db);
  const catalogRead = createCatalogReadRepo(ctx.db);
  const statusRead = createFlightStatusRepo(ctx.db);
  const hot = createHotState(ctx.redis, ctx.redisPrefix);
  const routeResolver = new FlightRouteResolver(ctx, read, catalog, catalogRead);

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

  // Resolve the scheduled leg from persisted/provider data, with ADSBDB only as
  // a geometry-validated fallback. ADS-B telemetry itself carries no route.
  app.get('/flights/route/:callsign', async (c) => {
    const cs = (c.req.param('callsign') ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(cs)) throw new AppError('BAD_REQUEST', 'invalid callsign');
    const parsed = routeObservationSchema.safeParse({
      flightId: c.req.query('flightId'),
      icao24: c.req.query('icao24'),
      date: c.req.query('date'),
      lat: c.req.query('lat'),
      lon: c.req.query('lon'),
      headingDeg: c.req.query('headingDeg'),
      onGround: c.req.query('onGround'),
      ts: c.req.query('ts'),
    });
    if (!parsed.success)
      throw new AppError('BAD_REQUEST', 'invalid route observation', {
        details: parsed.error.issues,
      });
    const route = await routeResolver.resolve(cs, {
      ...parsed.data,
      date: parsed.data.date ?? ctx.clock.nowIso().slice(0, 10),
    });
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

  app.post('/flights/live/tracks', async (c) => {
    const parsed = liveTrackSeedSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid track seed request', {
        details: parsed.error.issues,
      });

    const flightIds = [
      ...new Set(
        parsed.data.flights
          .map((f) => f.flightId.trim())
          .filter((id) =>
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
          ),
      ),
    ];
    const transientRequests = parsed.data.flights.flatMap((flight) => {
      const hex = flight.flightId.startsWith('adsb:') ? flight.flightId.slice(5) : flight.icao24;
      if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return [];
      return [
        {
          requestKey: flight.flightId,
          icao24: hex.toLowerCase(),
          callsign: flight.callsign?.trim().toUpperCase() || null,
          observedAt: flight.ts ?? ctx.clock.nowIso(),
        },
      ];
    });
    if (flightIds.length === 0 && transientRequests.length === 0)
      return ok(c, { tracks: [] }, true);

    const since = new Date(ctx.clock.now() - parsed.data.sinceMinutes * 60_000);
    const flightIdCsv = flightIds.join(',');
    const transientJson = JSON.stringify(transientRequests);
    const rows = (await ctx.db.execute(sql`
      with candidate_flights as (
        select f.id as flight_id,
               f.id::text as request_key,
               null::text as transient_flight_id
        from flights f
        where f.id = any(string_to_array(nullif(${flightIdCsv}, ''), ',')::uuid[])

        union

        select latest.flight_id,
               request."requestKey" as request_key,
               request."requestKey" as transient_flight_id
        from jsonb_to_recordset(${transientJson}::jsonb) as request(
          "requestKey" text,
          icao24 text,
          callsign text,
          "observedAt" timestamptz
        )
        join lateral (
          select fp.flight_id
          from flight_positions fp
          join flights f on f.id = fp.flight_id
          where lower(fp.icao24::text) = request.icao24
            and (request.callsign is null or upper(f.callsign) = request.callsign)
            and fp.ts >= request."observedAt" - interval '30 minutes'
            and fp.ts <= request."observedAt" + interval '2 minutes'
          order by fp.ts desc
          limit 1
        ) latest on true
      ),
      ranked as (
        select c.request_key as "requestKey",
               c.transient_flight_id as "transientFlightId",
               fp.flight_id as "flightId",
               fp.ts,
               fp.icao24,
               ST_Y(fp.location::geometry) as lat,
               ST_X(fp.location::geometry) as lon,
               fp.altitude_ft as "altitudeFt",
               fp.heading_deg as "headingDeg",
               row_number() over (partition by c.request_key order by fp.ts desc) as rn
        from candidate_flights c
        join flight_positions fp on fp.flight_id = c.flight_id
        where fp.ts >= ${since.toISOString()}::timestamptz
      )
      select "requestKey", "transientFlightId", "flightId", ts, icao24, lat, lon,
             "altitudeFt", "headingDeg"
      from ranked
      where rn <= ${parsed.data.limitPerFlight}
      order by "requestKey", ts asc
    `)) as unknown as LiveTrackSeedRow[];

    const byRequest = new Map<
      string,
      { persistedFlightId: string; transientFlightId: string | null; points: LiveTrackSeedPoint[] }
    >();
    for (const row of rows) {
      const current =
        byRequest.get(row.requestKey) ??
        ({
          persistedFlightId: row.flightId,
          transientFlightId: row.transientFlightId,
          points: [],
        } satisfies {
          persistedFlightId: string;
          transientFlightId: string | null;
          points: LiveTrackSeedPoint[];
        });
      current.points.push({
        ts: row.ts,
        icao24: row.icao24,
        lat: row.lat,
        lon: row.lon,
        altitudeFt: row.altitudeFt,
        headingDeg: row.headingDeg,
      });
      byRequest.set(row.requestKey, current);
    }

    return ok(c, {
      tracks: [...byRequest.entries()].map(([flightId, track]) => ({
        flightId,
        persistedFlightId: track.persistedFlightId,
        transientFlightId: track.transientFlightId,
        points: track.points,
        count: track.points.length,
      })),
    });
  });

  app.post('/flights/live/promote', requireUser(), async (c) => {
    const parsed = promoteLiveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      throw new AppError('VALIDATION_ERROR', 'invalid live flight', {
        details: parsed.error.issues,
      });

    const live =
      liveFromPromoteSnapshot(parsed.data.snapshot, ctx.clock.now()) ??
      (await lookupLiveIcao(extractAdsbIcao(parsed.data), ctx.clock.now()));
    if (!live) throw new AppError('FLIGHT_NOT_FOUND', 'live flight not found');

    const persisted = await promoteLiveFlight(read, write, live, ctx.clock.now());
    const flight = await read.getFlightById(persisted.flightId);
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'promoted flight not found');
    return ok(c, { flightId: persisted.flightId, detail: await detailFor(flight) }, true);
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
          flightId: flight.id,
          ...(dbLive.icao24 ? { icao24: dbLive.icao24 } : {}),
          callsign: flight.callsign,
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
      statusSnapshot: statusSnapshot ?? derivedStatusSnapshot(flight, live),
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
    statusSnapshot: derivedStatusSnapshot(
      {
        status: live.onGround ? 'landed' : 'active',
        source: live.source ?? 'adsb',
        lastSeenAt: live.ts,
        createdAt: live.ts,
      },
      detailLiveFromHot(live),
    ),
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
    const limit = Math.min(Number(c.req.query('limit') ?? 5000) || 5000, 10_000);
    if (flightId.startsWith('adsb:')) {
      const icao24 = flightId.slice('adsb:'.length).trim().toLowerCase();
      const callsign = (c.req.query('callsign') ?? '').trim().toUpperCase();
      const atMs = Date.parse(c.req.query('at') ?? '');
      const recent =
        /^[0-9a-f]{6}$/.test(icao24) && /^[A-Z0-9]{2,12}$/.test(callsign) && Number.isFinite(atMs)
          ? await read.getRecentFlightByIdentity(
              icao24,
              callsign,
              new Date(atMs - 30 * 60_000),
              new Date(atMs + 2 * 60_000),
            )
          : null;
      if (!recent) return ok(c, { flightId, points: [], count: 0 }, true);
      const points = await read.getTrack(recent.id, limit);
      return ok(c, {
        flightId: recent.id,
        transientFlightId: flightId,
        points,
        count: points.length,
      });
    }
    const flight = await read.getFlightById(flightId);
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
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

function extractAdsbIcao(input: z.infer<typeof promoteLiveSchema>): string {
  const raw =
    input.snapshot?.icao24 ??
    input.icao24 ??
    (input.flightId?.startsWith('adsb:') ? input.flightId.slice('adsb:'.length) : '');
  const icao24 = raw.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(icao24)) throw new AppError('BAD_REQUEST', 'hex must be 6 hex digits');
  return icao24;
}

function liveFromPromoteSnapshot(
  snapshot: z.infer<typeof promoteLiveSchema>['snapshot'],
  nowMs: number,
): LiveFlight | null {
  if (!snapshot) return null;
  const icao24 = snapshot.icao24.trim().toLowerCase();
  const tsMs = Date.parse(snapshot.ts);
  if (!Number.isFinite(tsMs)) return null;
  const ageMs = Math.max(0, nowMs - tsMs);
  return {
    flightId: snapshot.flightId ?? `adsb:${icao24}`,
    icao24,
    callsign: snapshot.callsign?.trim() || null,
    lat: snapshot.lat,
    lon: snapshot.lon,
    altitudeFt: snapshot.altitudeFt ?? null,
    geoAltitudeFt: snapshot.geoAltitudeFt ?? null,
    headingDeg: snapshot.headingDeg ?? null,
    groundSpeedKt: snapshot.groundSpeedKt ?? null,
    verticalRateFpm: snapshot.verticalRateFpm ?? null,
    onGround: snapshot.onGround ?? false,
    squawk: snapshot.squawk ?? null,
    category: snapshot.category ?? null,
    qualityState: qualityStateForAge(ageMs),
    source: snapshot.source ?? 'adsb',
    ...(snapshot.sourceTimestamp ? { sourceTimestamp: snapshot.sourceTimestamp } : {}),
    ageMs: Math.round(ageMs),
    qualityScore: qualityScoreForAge(ageMs),
    ...(snapshot.positionSource ? { positionSource: snapshot.positionSource } : {}),
    ...(snapshot.isMlat !== undefined ? { isMlat: snapshot.isMlat } : {}),
    receivedAt: new Date(nowMs).toISOString(),
    ts: snapshot.ts,
  };
}

async function promoteLiveFlight(
  read: ReturnType<typeof createFlightReadRepo>,
  write: ReturnType<typeof createFlightRepo>,
  live: LiveFlight,
  nowMs: number,
): Promise<{ flightId: string }> {
  const since = new Date(nowMs - PROMOTED_FLIGHT_REUSE_MS);
  const flightDate = live.ts.slice(0, 10);
  const existingByCallsign = live.callsign ? await read.getFlight(live.callsign, flightDate) : null;
  const reusableByCallsign = existingByCallsign?.status === 'active' ? existingByCallsign : null;
  const existingByIcao =
    !reusableByCallsign && !live.callsign
      ? await read.getRecentFlightByIcao24(live.icao24, since)
      : null;
  const reusableByIcao = existingByIcao?.status === 'active' ? existingByIcao : null;
  const flightId = reusableByCallsign?.id ?? reusableByIcao?.id ?? uuidv7(nowMs);
  const lastSeenAt = validDate(live.ts) ?? new Date(nowMs);

  await write.upsertFlight({
    flightId,
    callsign: live.callsign ?? live.icao24.toUpperCase(),
    flightDate,
    source: live.source ?? 'adsb',
    lastSeenAt,
  });
  await write.insertPositions([positionFromLive(flightId, live)]);
  await write.insertEvent({
    flightId,
    type: 'flight_detected',
    occurredAt: lastSeenAt,
    confidence: 1,
    source: live.source ?? 'adsb',
    payload: {
      flightId,
      icao24: live.icao24,
      callsign: live.callsign,
      firstPosition: { lat: live.lat, lon: live.lon, ts: live.ts },
      source: live.source ?? 'adsb',
    },
    dedupeKey: `${flightId}:detected`,
  });
  return { flightId };
}

function derivedStatusSnapshot(
  flight: Pick<FlightRow, 'status' | 'source' | 'lastSeenAt' | 'createdAt'>,
  live: FlightDetail['live'],
): NonNullable<FlightDetail['statusSnapshot']> {
  return {
    providerKey: live?.source ?? flight.source ?? 'derived',
    status: live?.onGround
      ? 'landed'
      : flight.status === 'unknown' && live
        ? 'active'
        : flight.status,
    gate: null,
    terminal: null,
    baggageBelt: null,
    scheduledDeparture: null,
    estimatedDeparture: null,
    actualDeparture: null,
    scheduledArrival: null,
    estimatedArrival: null,
    actualArrival: null,
    fetchedAt: live?.ts ?? flight.lastSeenAt ?? flight.createdAt,
  };
}

function positionFromLive(flightId: string, live: LiveFlight) {
  return {
    flightId,
    ts: validDate(live.ts) ?? new Date(),
    icao24: live.icao24,
    lon: live.lon,
    lat: live.lat,
    altitudeFt: live.altitudeFt,
    geoAltitudeFt: live.geoAltitudeFt ?? null,
    headingDeg: live.headingDeg,
    groundSpeedKt: live.groundSpeedKt,
    verticalRateFpm: live.verticalRateFpm ?? null,
    onGround: live.onGround,
    squawk: live.squawk ?? null,
    source: live.source ?? 'adsb',
  };
}

function validDate(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
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
    cacheLiveByIcao(flight, nowMs);
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
  const cached = cachedLiveByIcao(hex, nowMs);
  if (cached) return cached;
  try {
    const res = await fetch(`${ADSB_LIVE_API_URL}/hex/${encodeURIComponent(hex)}`, {
      headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const ac = ((await res.json()) as { ac?: AdsbViewportAircraft[] }).ac ?? [];
    for (const raw of ac) {
      const live = liveFlightFromAdsb(raw, nowMs);
      if (live?.icao24 === hex) {
        cacheLiveByIcao(live, nowMs);
        return live;
      }
    }
    return null;
  } catch (err) {
    if (err instanceof AppError) throw err;
    return null;
  }
}

function cacheLiveByIcao(live: LiveFlight, nowMs: number): void {
  liveByIcaoCache.set(live.icao24, { exp: nowMs + ADSB_DETAIL_TTL_MS, value: live });
  if (liveByIcaoCache.size <= 1000) return;
  for (const [key, cached] of liveByIcaoCache) {
    if (cached.exp <= nowMs) liveByIcaoCache.delete(key);
  }
  while (liveByIcaoCache.size > 1000) {
    const oldest = liveByIcaoCache.keys().next().value as string | undefined;
    if (!oldest) break;
    liveByIcaoCache.delete(oldest);
  }
}

function cachedLiveByIcao(icao24: string, nowMs: number): LiveFlight | null {
  const cached = liveByIcaoCache.get(icao24);
  if (!cached) return null;
  if (cached.exp <= nowMs) {
    liveByIcaoCache.delete(icao24);
    return null;
  }
  return refreshLiveAge(cached.value, nowMs);
}

function refreshLiveAge(live: LiveFlight, nowMs: number): LiveFlight {
  const tsMs = Date.parse(live.ts);
  if (!Number.isFinite(tsMs)) return live;
  const ageMs = Math.max(0, nowMs - tsMs);
  return {
    ...live,
    ageMs: Math.round(ageMs),
    qualityScore: qualityScoreForAge(ageMs),
    qualityState: qualityStateForAge(ageMs),
    receivedAt: new Date(nowMs).toISOString(),
  };
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
