import type { CatalogReadRepo, CatalogRepo, FlightReadRepo, FlightRouteRow } from '@flytrace/db';
import {
  AeroDataBoxProvider,
  type HttpClient,
  type NormalizedFlightStatus,
  type ProviderCache,
  type RateLimiter,
} from '@flytrace/providers';
import { routeMatchesPosition } from '@flytrace/shared';
import type { AppContext } from '../context.ts';

const ADSBDB_UA = 'FlyTrace/1.0 (+https://flytrace.app; live flight tracker)';
const ROUTE_TTL_MS = 6 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface AdsbdbAirport {
  iata_code?: string;
  name?: string;
  municipality?: string;
  latitude?: number;
  longitude?: number;
}

export interface RouteAirport {
  iata: string;
  name: string;
  city: string | null;
  lat: number;
  lon: number;
}

export interface FlightRoute {
  airline: string | null;
  origin: RouteAirport;
  destination: RouteAirport;
  source: 'database' | 'aerodatabox' | 'adsbdb';
  confidence: number;
}

export interface RouteObservation {
  flightId?: string | undefined;
  icao24?: string | undefined;
  date: string;
  lat?: number | undefined;
  lon?: number | undefined;
  headingDeg?: number | null | undefined;
  onGround?: boolean | undefined;
  ts?: string | undefined;
}

export class FlightRouteResolver {
  private readonly adsbdbCache = new Map<string, { route: FlightRoute | null; exp: number }>();
  private readonly aeroProvider: AeroDataBoxProvider | null;
  private readonly aeroReady: Promise<void> | null;

  constructor(
    private readonly ctx: AppContext,
    private readonly read: FlightReadRepo,
    private readonly catalog: CatalogRepo,
    private readonly catalogRead: CatalogReadRepo,
  ) {
    const apiKey = ctx.config.AERODATABOX_API_KEY;
    if (!apiKey) {
      this.aeroProvider = null;
      this.aeroReady = null;
      return;
    }

    this.aeroProvider = new AeroDataBoxProvider();
    this.aeroReady = this.aeroProvider.init({
      http: new RouteHttpClient(),
      cache: new RedisRouteCache(ctx),
      rateLimiter: new RedisRouteRateLimiter(ctx),
      logger: ctx.logger,
      clock: ctx.clock,
      config: {
        aerodatabox: {
          apiKey,
          marketplace: ctx.config.AERODATABOX_MARKETPLACE,
          baseUrl: ctx.config.AERODATABOX_BASE_URL,
        },
      },
    });
  }

  async resolve(callsign: string, observation: RouteObservation): Promise<FlightRoute | null> {
    const databaseRoute = await this.databaseRoute(observation);
    if (databaseRoute && routeMatchesObservation(databaseRoute, observation)) return databaseRoute;

    const [aeroRoute, adsbdbRoute] = await Promise.all([
      this.aeroRoute(callsign, observation),
      this.adsbdbRoute(callsign, observation.date),
    ]);
    if (aeroRoute && routeMatchesObservation(aeroRoute, observation)) return aeroRoute;
    if (adsbdbRoute && routeMatchesObservation(adsbdbRoute, observation)) return adsbdbRoute;
    return null;
  }

  private async databaseRoute(observation: RouteObservation): Promise<FlightRoute | null> {
    let flightId = observation.flightId;
    if (!flightId || !UUID_RE.test(flightId)) {
      if (!observation.icao24) return null;
      const recent = await this.read.getRecentFlightByIcao24(
        observation.icao24,
        new Date(this.ctx.clock.now() - 18 * 60 * 60 * 1000),
      );
      flightId = recent?.id;
    }
    if (!flightId) return null;
    return routeFromDatabase(await this.read.getRoute(flightId));
  }

  private async aeroRoute(
    callsign: string,
    observation: RouteObservation,
  ): Promise<FlightRoute | null> {
    if (!this.aeroProvider || !this.aeroReady) return null;
    await this.aeroReady;
    const result = await this.aeroProvider.getFlightStatus({
      by: 'flightNumber',
      flightNumber: callsign,
      date: observation.date,
      callsign,
      icao24: observation.icao24 ?? null,
    });
    if (!result || !providerLegMatchesObservation(result.status, observation)) return null;

    const [origin, destination, airline] = await Promise.all([
      this.catalogRead.getAirportByCode(result.status.origin),
      this.catalogRead.getAirportByCode(result.status.destination),
      this.catalog.getAirlineByIcao(callsign.slice(0, 3)),
    ]);
    if (!origin || !destination || origin.lat == null || origin.lon == null) return null;
    if (destination.lat == null || destination.lon == null) return null;
    return {
      airline: airline?.name ?? null,
      origin: airportFromCatalog(origin),
      destination: airportFromCatalog(destination),
      source: 'aerodatabox',
      confidence: result.status.confidence,
    };
  }

  private async adsbdbRoute(callsign: string, date: string): Promise<FlightRoute | null> {
    const key = `${callsign}:${date}`;
    const cached = this.adsbdbCache.get(key);
    if (cached && cached.exp > this.ctx.clock.now()) return cached.route;

    let route: FlightRoute | null = null;
    try {
      const res = await fetch(
        `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(callsign)}`,
        {
          headers: { accept: 'application/json', 'user-agent': ADSBDB_UA },
          signal: AbortSignal.timeout(6000),
        },
      );
      if (res.ok) {
        const flightRoute = (
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
        const origin = flightRoute?.origin ? airportFromAdsbdb(flightRoute.origin) : null;
        const destination = flightRoute?.destination
          ? airportFromAdsbdb(flightRoute.destination)
          : null;
        if (origin && destination) {
          route = {
            airline: flightRoute?.airline?.name ?? null,
            origin,
            destination,
            source: 'adsbdb',
            confidence: 0.58,
          };
        }
      }
    } catch {
      // A missing fallback route must not break the live map.
    }
    this.adsbdbCache.set(key, { route, exp: this.ctx.clock.now() + ROUTE_TTL_MS });
    return route;
  }
}

export function routeMatchesObservation(
  route: Pick<FlightRoute, 'origin' | 'destination'>,
  observation: Pick<RouteObservation, 'lat' | 'lon' | 'headingDeg' | 'onGround'>,
): boolean {
  if (observation.lat == null || observation.lon == null) return true;
  const current = { lat: observation.lat, lon: observation.lon };
  return routeMatchesPosition(route.origin, route.destination, {
    ...current,
    headingDeg: observation.headingDeg,
    onGround: observation.onGround,
  });
}

function providerLegMatchesObservation(
  status: NormalizedFlightStatus,
  observation: RouteObservation,
): boolean {
  if (observation.onGround !== false || status.status !== 'landed' || !observation.ts) return true;
  const arrival = status.actualArrival ?? status.scheduledArrival;
  if (!arrival) return true;
  const ageMs = Date.parse(observation.ts) - Date.parse(arrival);
  return !Number.isFinite(ageMs) || ageMs <= 90 * 60_000;
}

function routeFromDatabase(row: FlightRouteRow | null): FlightRoute | null {
  if (!row) return null;
  return {
    airline: row.airline,
    origin: {
      iata: row.originIata ?? '',
      name: row.originName,
      city: row.originCity,
      lat: row.originLat,
      lon: row.originLon,
    },
    destination: {
      iata: row.destinationIata ?? '',
      name: row.destinationName,
      city: row.destinationCity,
      lat: row.destinationLat,
      lon: row.destinationLon,
    },
    source: 'database',
    confidence: 0.95,
  };
}

function airportFromCatalog(airport: {
  iata: string | null;
  icao: string;
  name: string;
  city: string | null;
  lat: number | null;
  lon: number | null;
}): RouteAirport {
  return {
    iata: airport.iata ?? airport.icao,
    name: airport.name,
    city: airport.city,
    lat: airport.lat as number,
    lon: airport.lon as number,
  };
}

function airportFromAdsbdb(airport: AdsbdbAirport): RouteAirport | null {
  if (!Number.isFinite(airport.latitude) || !Number.isFinite(airport.longitude)) return null;
  return {
    iata: airport.iata_code ?? '',
    name: airport.name ?? '',
    city: airport.municipality ?? null,
    lat: airport.latitude as number,
    lon: airport.longitude as number,
  };
}

class RouteHttpClient implements HttpClient {
  async getJson(
    url: string,
    opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<unknown> {
    const response = await fetch(url, {
      headers: { accept: 'application/json', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }
}

class RedisRouteCache implements ProviderCache {
  constructor(private readonly ctx: AppContext) {}

  get(key: string): Promise<string | null> {
    return this.ctx.redis.get(`${this.ctx.redisPrefix}${key}`);
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    await this.ctx.redis.set(`${this.ctx.redisPrefix}${key}`, value, 'PX', ttlMs);
  }
}

class RedisRouteRateLimiter implements RateLimiter {
  constructor(private readonly ctx: AppContext) {}

  async tryAcquire(key: string): Promise<boolean> {
    const redisKey = `${this.ctx.redisPrefix}route:${key}`;
    const count = await this.ctx.redis.incr(redisKey);
    if (count === 1) await this.ctx.redis.pexpire(redisKey, 60_000);
    return count <= 20;
  }
}
