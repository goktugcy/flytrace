import {
  type AirportDetail,
  createAirportGroundEventRepo,
  createAirportGroundReadRepo,
  createCatalogReadRepo,
} from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import { createHotState } from '../flights/hot-state.ts';

/**
 * Coarse ground state from altitude/speed alone, used as a fallback when the
 * geometry-aware ground pipeline hasn't classified an aircraft yet. Deliberately
 * conservative: it never claims gate/runway detail it cannot know without OSM
 * geometry — just the broad phase (parked / taxi / roll / climb / approach).
 */
function coarseGroundState(
  f: {
    altitudeFt: number | null;
    groundSpeedKt: number | null;
    verticalRateFpm?: number | null | undefined;
    onGround: boolean;
  },
  fieldElevationFt: number,
): string {
  const gs = f.groundSpeedKt ?? 0;
  const vr = f.verticalRateFpm ?? 0;
  const nearGround = f.onGround || (f.altitudeFt != null && f.altitudeFt <= fieldElevationFt + 150);
  if (nearGround) {
    if (gs >= 55) return 'TAKEOFF_ROLL';
    if (gs >= 3) return 'TAXI_OUT';
    return 'AT_GATE';
  }
  const agl = f.altitudeFt != null ? f.altitudeFt - fieldElevationFt : null;
  if (agl != null && agl < 4000) {
    if (vr <= -256) return 'APPROACH';
    if (vr >= 256) return 'CLIMB';
  }
  return 'AIRBORNE';
}

/**
 * Airport ground-operations API (Phase 5). Serves imported OSM geometry, the
 * live aircraft in the airport area, each aircraft's current ground state, and
 * the recent operations timeline — all from free/open data.
 */
export function createAirportOpsRoutes(ctx: AppContext): Hono<AppEnv> {
  const ground = createAirportGroundReadRepo(ctx.db);
  const groundEvents = createAirportGroundEventRepo(ctx.db);
  const catalog = createCatalogReadRepo(ctx.db);
  const hot = createHotState(ctx.redis, ctx.redisPrefix);

  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId') } });

  const requireAirport = async (raw: string | undefined): Promise<AirportDetail> => {
    const icao = (raw ?? '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,4}$/.test(icao)) throw new AppError('BAD_REQUEST', 'invalid ICAO code');
    const airport = await catalog.getAirportByIcao(icao);
    if (!airport) throw new AppError('NOT_FOUND', `airport ${icao} not found`);
    return airport;
  };

  const airportBbox = (a: AirportDetail): [number, number, number, number] => {
    const lat = a.lat ?? 0;
    const lon = a.lon ?? 0;
    const pad = 0.15; // ~15 km — covers the manoeuvring area + approach/departure
    return [lon - pad, lat - pad, lon + pad, lat + pad];
  };

  const toFeatureCollection = (rows: Awaited<ReturnType<typeof ground.byAirportId>>) => ({
    type: 'FeatureCollection' as const,
    features: rows
      .filter((r) => r.geojson)
      .map((r) => ({
        type: 'Feature' as const,
        id: r.id,
        geometry: r.geojson,
        properties: { id: r.id, kind: r.kind, ref: r.ref, name: r.name },
      })),
  });

  // Airports that have imported ground geometry.
  app.get('/airports', async (c) => ok(c, { airports: await ground.listAirportsWithGeometry() }));

  // Airport header + feature counts.
  app.get('/airport/:icao', async (c) => {
    const airport = await requireAirport(c.req.param('icao'));
    const featureCounts: Record<string, number> = {};
    for (const g of await ground.byAirportId(airport.id)) {
      featureCounts[g.kind] = (featureCounts[g.kind] ?? 0) + 1;
    }
    return ok(c, { airport, featureCounts });
  });

  const geometryEndpoint = (kind: string) => async (c: Context<AppEnv>) => {
    const airport = await requireAirport(c.req.param('icao'));
    const rows = (await ground.byAirportId(airport.id)).filter((r) => r.kind === kind);
    return ok(c, toFeatureCollection(rows));
  };
  app.get('/airport/:icao/gates', geometryEndpoint('gate'));
  app.get('/airport/:icao/runways', geometryEndpoint('runway'));
  app.get('/airport/:icao/taxiways', geometryEndpoint('taxiway'));

  // All ground geometry as one FeatureCollection (styled by properties.kind).
  app.get('/airport/:icao/geometry', async (c) => {
    const airport = await requireAirport(c.req.param('icao'));
    return ok(c, toFeatureCollection(await ground.byAirportId(airport.id)));
  });

  // Live aircraft in the airport area (hot state).
  app.get('/airport/:icao/aircraft', async (c) => {
    const airport = await requireAirport(c.req.param('icao'));
    const aircraft = await hot.live(airportBbox(airport));
    return ok(c, { aircraft, count: aircraft.length });
  });

  // Live aircraft in the airport area, each tagged with a ground state. We start
  // from the live ADS-B positions (hot state) so the view populates immediately,
  // and overlay the geometry-aware computed state when the ground pipeline has
  // produced one; otherwise we fall back to a coarse altitude/speed heuristic.
  app.get('/airport/:icao/ground', async (c) => {
    const airport = await requireAirport(c.req.param('icao'));
    const [current, live] = await Promise.all([
      groundEvents.currentByAirport(airport.id),
      hot.live(airportBbox(airport)),
    ]);
    const stateByIcao = new Map(
      current.filter((g) => g.icao24).map((g) => [g.icao24 as string, g]),
    );
    // Airport view is a close-up, so only plot positions we currently know
    // accurately. Stale fixes (e.g. an OpenSky snapshot up to its poll interval
    // old) would misplace a fast aircraft by kilometres — better to omit them
    // than draw a "takeoff roll" off the runway. The adsb feed stays fresh (~5 s).
    const FRESH_MS = 30_000;
    const nowMs = Date.now();
    const freshLive = live.filter((f) => {
      const t = Date.parse(f.ts);
      return !Number.isFinite(t) || nowMs - t <= FRESH_MS;
    });
    const elev = airport.elevationFt ?? 0;
    const aircraft = freshLive.map((f) => {
      const g = f.icao24 ? stateByIcao.get(f.icao24) : undefined;
      return {
        flightId: g?.flightId ?? f.flightId,
        icao24: f.icao24,
        callsign: f.callsign ?? null,
        state: g?.state ?? coarseGroundState(f, elev),
        stateSource: g ? ('computed' as const) : ('coarse' as const),
        gateRef: g?.gateRef ?? null,
        runwayRef: g?.runwayRef ?? null,
        lat: f.lat,
        lon: f.lon,
        speedKt: f.groundSpeedKt ?? null,
        headingDeg: f.headingDeg ?? null,
        altitudeFt: f.altitudeFt ?? null,
        onGround: f.onGround,
        lastUpdate: f.ts,
      };
    });
    return ok(c, { icao: airport.icao, aircraft, count: aircraft.length });
  });

  // Recent ground-movement timeline for the airport.
  app.get('/airport/:icao/operations', async (c) => {
    const airport = await requireAirport(c.req.param('icao'));
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 500);
    return ok(c, { operations: await groundEvents.recentForAirport(airport.id, limit) });
  });

  return app;
}
