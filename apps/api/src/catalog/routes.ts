import { createCatalogReadRepo } from '@flytrace/db';
import { AppError } from '@flytrace/shared';
import { type Context, Hono } from 'hono';
import { z } from 'zod';
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
const AIRPORT_PHOTO_TTL_MS = 6 * 60 * 60 * 1000;
const airportPhotoCache = new Map<string, { data: AirportPhoto | null; exp: number }>();
const AIRPORT_TYPES = [
  'large_airport',
  'medium_airport',
  'small_airport',
  'heliport',
  'seaplane_base',
  'balloonport',
  'closed',
] as const;

interface AirportPhoto {
  url: string;
  pageUrl: string | null;
  source: 'wikimedia';
}

interface AirportFeatureCollection {
  type: 'FeatureCollection';
  features: {
    type: 'Feature';
    id: string;
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: {
      id: string;
      iata: string | null;
      icao: string;
      name: string;
      type: string | null;
      city: string | null;
      country: string | null;
      elevationFt: number | null;
      runwayCount: number;
      scheduledService: boolean;
      homeUrl: string | null;
      wikipediaUrl: string | null;
    };
  }[];
  count: number;
  filters: { types: string[]; includeClosed: boolean };
}

const bboxSchema = z.string().transform((v, ctx) => {
  const parts = v.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox must be "w,s,e,n"' });
    return z.NEVER;
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  if (west < -180 || west > 180 || east < -180 || east > 180) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox longitudes must be in [-180,180]' });
    return z.NEVER;
  }
  if (south < -90 || south > 90 || north < -90 || north > 90 || south >= north) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'bbox latitudes must be ordered' });
    return z.NEVER;
  }
  return [west, south, east, north] as const;
});

export function createCatalogRoutes(ctx: AppContext): Hono<AppEnv> {
  const read = createCatalogReadRepo(ctx.db);
  const app = new Hono<AppEnv>();
  const ok = (c: Context<AppEnv>, data: unknown, cached = false) =>
    c.json({ data, meta: { requestId: c.get('requestId'), cached } });

  app.get('/airports/viewport', async (c) => {
    const parsed = bboxSchema.safeParse(c.req.query('bbox'));
    if (!parsed.success)
      throw new AppError('BAD_REQUEST', 'invalid bbox', { details: parsed.error.issues });
    const zoom = Number(c.req.query('zoom') ?? 5);
    const types = airportTypesForQuery(c.req.query('types'), Number.isFinite(zoom) ? zoom : 5);
    const includeClosed = c.req.query('includeClosed') === 'true';
    const limit = Math.min(Number(c.req.query('limit') ?? 1200) || 1200, 2500);
    const rows = await read.getAirportsInViewport(parsed.data, { types, includeClosed, limit });
    const data: AirportFeatureCollection = {
      type: 'FeatureCollection',
      count: rows.length,
      filters: { types, includeClosed },
      features: rows.map((a) => ({
        type: 'Feature',
        id: a.id,
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: {
          id: a.id,
          iata: a.iata,
          icao: a.icao,
          name: a.name,
          type: a.type,
          city: a.city,
          country: a.country,
          elevationFt: a.elevationFt,
          runwayCount: a.runwayCount,
          scheduledService: a.scheduledService,
          homeUrl: a.homeUrl,
          wikipediaUrl: a.wikipediaUrl,
        },
      })),
    };
    return ok(c, data, true);
  });

  app.get('/airports/id/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new AppError('BAD_REQUEST', 'invalid airport id');
    }
    const airport = await read.getAirportById(id);
    if (!airport) throw new AppError('NOT_FOUND', 'airport not found');
    const limit = Math.min(Number(c.req.query('limit') ?? 8) || 8, 30);
    const [departures, arrivals, stats, photo] = await Promise.all([
      read.getAirportBoard(airport.id, 'departure', limit),
      read.getAirportBoard(airport.id, 'arrival', limit),
      read.getAirportStats(airport.id),
      airportPhoto(airport.wikipediaUrl),
    ]);
    return ok(c, { airport: { ...airport, photo }, departures, arrivals, stats });
  });

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

function airportTypesForQuery(raw: string | undefined, zoom: number): string[] {
  if (raw) {
    const requested = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return requested.filter((t) => (AIRPORT_TYPES as readonly string[]).includes(t));
  }
  if (zoom < 5) return ['large_airport'];
  if (zoom < 7) return ['large_airport', 'medium_airport'];
  if (zoom < 9) return ['large_airport', 'medium_airport', 'small_airport'];
  return ['large_airport', 'medium_airport', 'small_airport', 'heliport', 'seaplane_base'];
}

async function airportPhoto(wikipediaUrl: string | null): Promise<AirportPhoto | null> {
  if (!wikipediaUrl) return null;
  const cached = airportPhotoCache.get(wikipediaUrl);
  if (cached && cached.exp > Date.now()) return cached.data;
  let data: AirportPhoto | null = null;
  try {
    const summaryUrl = wikipediaSummaryUrl(wikipediaUrl);
    if (summaryUrl) {
      const res = await fetch(summaryUrl, {
        headers: {
          accept: 'application/json',
          'user-agent': 'FlyTrace/1.0 (+https://flytrace.app)',
        },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const body = (await res.json()) as {
          thumbnail?: { source?: string };
          originalimage?: { source?: string };
          content_urls?: { desktop?: { page?: string } };
        };
        const url = body.thumbnail?.source ?? body.originalimage?.source;
        if (url) {
          data = {
            url,
            pageUrl: body.content_urls?.desktop?.page ?? wikipediaUrl,
            source: 'wikimedia',
          };
        }
      }
    }
  } catch {
    /* no airport photo — card falls back to an icon */
  }
  airportPhotoCache.set(wikipediaUrl, { data, exp: Date.now() + AIRPORT_PHOTO_TTL_MS });
  return data;
}

function wikipediaSummaryUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (!url.hostname.endsWith('.wikipedia.org')) return null;
    const match = url.pathname.match(/^\/wiki\/(.+)$/);
    if (!match) return null;
    return `https://${url.hostname}/api/rest_v1/page/summary/${match[1]}`;
  } catch {
    return null;
  }
}
