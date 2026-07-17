import { createCatalogReadRepo } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import type { AppEnv } from '../app.ts';
import type { AppContext } from '../context.ts';

/**
 * Public catalog endpoints (docs/11 §11.6) backing the airport & aircraft
 * pages: an entity header plus the recent flights that touched it. Misses raise
 * a typed AppError rendered into the standard envelope by the app error mapper.
 */
export function createCatalogRoutes(ctx: AppContext): Hono<AppEnv> {
  const read = createCatalogReadRepo(ctx.db);
  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown) =>
    c.json({ data, meta: { requestId: c.get('requestId') } });

  // Airport by IATA code (e.g. /airports/IST).
  app.get('/airports/:iata', async (c) => {
    const iata = (c.req.param('iata') ?? '').trim();
    if (iata.length !== 3) throw new AppError('BAD_REQUEST', 'iata must be a 3-letter code');
    const airport = await read.getAirportByIata(iata);
    if (!airport) throw new AppError('NOT_FOUND', `airport ${iata.toUpperCase()} not found`);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const flights = await read.getAirportFlights(airport.id, limit);
    return ok(c, { airport, flights });
  });

  // Aircraft by registration (tail number, e.g. /aircraft/TC-JJE).
  app.get('/aircraft/:registration', async (c) => {
    const reg = (c.req.param('registration') ?? '').trim();
    if (reg.length < 2) throw new AppError('BAD_REQUEST', 'registration is required');
    const aircraft = await read.getAircraftByRegistration(reg);
    if (!aircraft) throw new AppError('NOT_FOUND', `aircraft ${reg.toUpperCase()} not found`);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const flights = await read.getAircraftFlights(aircraft.id, limit);
    return ok(c, { aircraft, flights });
  });

  return app;
}
