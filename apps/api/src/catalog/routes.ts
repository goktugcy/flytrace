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
interface Weather {
  tempC: number | null;
  windKt: number | null;
  code: number;
  isDay: boolean;
}
const WEATHER_TTL_MS = 15 * 60 * 1000; // 15 min — current conditions move slowly
const weatherCache = new Map<string, { data: Weather | null; exp: number }>();

export function createCatalogRoutes(ctx: AppContext): Hono<AppEnv> {
  const read = createCatalogReadRepo(ctx.db);
  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown, cached = false) =>
    c.json({ data, meta: { requestId: c.get('requestId'), cached } });

  // Current weather at an airport via Open-Meteo (keyless, non-commercial-free,
  // compliant). Separate endpoint so it loads progressively and degrades on its
  // own without blocking the board. Cached to stay polite.
  app.get('/airports/:iata/weather', async (c) => {
    const iata = (c.req.param('iata') ?? '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata)) throw new AppError('BAD_REQUEST', 'iata must be a 3-letter code');
    const hit = weatherCache.get(iata);
    if (hit && hit.exp > Date.now()) return ok(c, { weather: hit.data }, true);
    const airport = await read.getAirportByIata(iata);
    if (!airport) throw new AppError('NOT_FOUND', `airport ${iata} not found`);
    let weather: Weather | null = null;
    if (airport.lat != null && airport.lon != null) {
      try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${airport.lat}&longitude=${airport.lon}&current=temperature_2m,weather_code,wind_speed_10m,is_day&wind_speed_unit=kn`;
        const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          const cur = (
            (await res.json()) as {
              current?: {
                temperature_2m?: number;
                weather_code?: number;
                wind_speed_10m?: number;
                is_day?: number;
              };
            }
          ).current;
          if (cur) {
            weather = {
              tempC: cur.temperature_2m ?? null,
              windKt: cur.wind_speed_10m ?? null,
              code: cur.weather_code ?? 0,
              isDay: cur.is_day === 1,
            };
          }
        }
      } catch {
        /* no weather — degrade gracefully */
      }
    }
    weatherCache.set(iata, { data: weather, exp: Date.now() + WEATHER_TTL_MS });
    return ok(c, { weather });
  });

  // Airport by IATA code (e.g. /airports/IST) — header, live boards, stats.
  app.get('/airports/:iata', async (c) => {
    const iata = (c.req.param('iata') ?? '').trim();
    if (iata.length !== 3) throw new AppError('BAD_REQUEST', 'iata must be a 3-letter code');
    const airport = await read.getAirportByIata(iata);
    if (!airport) throw new AppError('NOT_FOUND', `airport ${iata.toUpperCase()} not found`);
    const limit = Math.min(Number(c.req.query('limit') ?? 30) || 30, 100);
    const [departures, arrivals, stats] = await Promise.all([
      read.getAirportBoard(airport.id, 'departure', limit),
      read.getAirportBoard(airport.id, 'arrival', limit),
      read.getAirportStats(airport.id),
    ]);
    return ok(c, { airport, departures, arrivals, stats });
  });

  // Aircraft by registration (tail number, e.g. /aircraft/TC-JJE) — history + utilization.
  app.get('/aircraft/:registration', async (c) => {
    const reg = (c.req.param('registration') ?? '').trim();
    if (reg.length < 2) throw new AppError('BAD_REQUEST', 'registration is required');
    const aircraft = await read.getAircraftByRegistration(reg);
    if (!aircraft) throw new AppError('NOT_FOUND', `aircraft ${reg.toUpperCase()} not found`);
    const limit = Math.min(Number(c.req.query('limit') ?? 50) || 50, 100);
    const [flights, stats] = await Promise.all([
      read.getAircraftFlights(aircraft.id, limit),
      read.getAircraftStats(aircraft.id),
    ]);
    return ok(c, { aircraft, flights, stats });
  });

  return app;
}
