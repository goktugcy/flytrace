import { type FlightRow, createFlightReadRepo } from '@flytrace/db';
import { AppError, type FlightDetail } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';
import type { Bbox } from '../ws/channels.ts';
import { createHotState } from './hot-state.ts';

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
  const hot = createHotState(ctx.redis, ctx.redisPrefix);

  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown, cached = false) =>
    c.json({ data, meta: { requestId: c.get('requestId'), cached } });

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

  // Typeahead search over flights (callsign / flight number).
  app.get('/flights/search', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 1) return ok(c, { results: [] });
    const limit = Math.min(Number(c.req.query('limit') ?? 20) || 20, 50);
    return ok(c, { results: await read.search(q, limit) });
  });

  // Landing-page live counters.
  app.get('/stats/live', async (c) => {
    const [flightsLive, eventsToday] = await Promise.all([hot.count(), read.countEventsToday()]);
    return ok(c, { flightsLive, eventsToday }, true);
  });

  const detailFor = async (flight: FlightRow): Promise<FlightDetail> => {
    const [live, events] = await Promise.all([
      read.getLatestPosition(flight.id),
      read.getEvents(flight.id),
    ]);
    return {
      flight: {
        flightId: flight.id,
        callsign: flight.callsign,
        flightNumber: flight.flightNumber,
        status: flight.status,
        flightDate: flight.flightDate,
        source: flight.source,
      },
      live: live
        ? {
            lat: live.lat,
            lon: live.lon,
            altitudeFt: live.altitudeFt,
            headingDeg: live.headingDeg,
            groundSpeedKt: live.groundSpeedKt,
            verticalRateFpm: live.verticalRateFpm,
            onGround: live.onGround,
            ts: live.ts,
          }
        : null,
      timeline: events.map((e) => ({
        type: e.type,
        occurredAt: e.occurredAt,
        confidence: e.confidence,
        source: e.source,
      })),
    };
  };

  // By flightId (map/WS use uuids) — static `id` segment precedes :callsign.
  app.get('/flights/id/:flightId', async (c) => {
    const flight = await read.getFlightById(c.req.param('flightId'));
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
    return ok(c, await detailFor(flight));
  });

  app.get('/flights/id/:flightId/track', async (c) => {
    const flight = await read.getFlightById(c.req.param('flightId'));
    if (!flight) throw new AppError('FLIGHT_NOT_FOUND', 'flight not found');
    const limit = Math.min(Number(c.req.query('limit') ?? 5000) || 5000, 10_000);
    const points = await read.getTrack(flight.id, limit);
    return ok(c, { flightId: flight.id, points, count: points.length });
  });

  app.get('/flights/id/:flightId/events', async (c) => {
    const flight = await read.getFlightById(c.req.param('flightId'));
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
