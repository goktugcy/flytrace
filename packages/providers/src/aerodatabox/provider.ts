import { z } from 'zod';
import { BaseProvider } from '../base-provider.ts';
import { DEFAULT_TIMEOUT_MS, USER_AGENT } from '../common/http.ts';
import { type CanonicalStatus, buildNormalized, mapStatus } from '../common/normalize.ts';
import type {
  FlightStatusQuery,
  NormalizedFlightStatus,
  ProviderCapabilities,
  ProviderFactory,
} from '../types.ts';

const APIMARKET_BASE_URL = 'https://prod.api.market/api/v1/aedbx/aerodatabox';
const RAPIDAPI_BASE_URL = 'https://aerodatabox.p.rapidapi.com';
const RAPIDAPI_HOST = 'aerodatabox.p.rapidapi.com';

const dateTimeSchema = z
  .object({
    utc: z.string().optional(),
    local: z.string().optional(),
  })
  .passthrough();

const airportSchema = z
  .object({
    iata: z.string().nullish(),
    icao: z.string().nullish(),
    name: z.string().optional(),
  })
  .passthrough();

const movementSchema = z
  .object({
    airport: airportSchema,
    scheduledTime: dateTimeSchema.nullish(),
    revisedTime: dateTimeSchema.nullish(),
    predictedTime: dateTimeSchema.nullish(),
    runwayTime: dateTimeSchema.nullish(),
    terminal: z.string().nullish(),
    gate: z.string().nullish(),
    baggageBelt: z.string().nullish(),
  })
  .passthrough();

const flightSchema = z
  .object({
    number: z.string(),
    callSign: z.string().nullish(),
    status: z.string(),
    codeshareStatus: z.string().optional(),
    lastUpdatedUtc: z.string().optional(),
    departure: movementSchema,
    arrival: movementSchema,
    aircraft: z
      .object({
        reg: z.string().nullish(),
        model: z.string().nullish(),
      })
      .passthrough()
      .optional(),
    airline: z
      .object({
        iata: z.string().nullish(),
        icao: z.string().nullish(),
        name: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const aerodataboxRawSchema = z
  .array(flightSchema)
  .nullish()
  .transform((raw) => raw ?? []);
export type AeroDataBoxRaw = z.infer<typeof aerodataboxRawSchema>;

const AERODATABOX_VOCAB: Record<string, CanonicalStatus> = {
  unknown: 'unknown',
  expected: 'scheduled',
  checkin: 'scheduled',
  boarding: 'scheduled',
  gateclosed: 'scheduled',
  enroute: 'active',
  departed: 'active',
  approaching: 'active',
  delayed: 'delayed',
  arrived: 'landed',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  canceleduncertain: 'cancelled',
  diverted: 'diverted',
};

interface AeroDataBoxProviderConfig {
  apiKey: string;
  marketplace: 'apimarket' | 'rapidapi';
  baseUrl: string;
}

/** Pure AeroDataBox flight array → canonical provider status. */
export function normalizeAeroDataBox(
  raw: AeroDataBoxRaw,
  q: FlightStatusQuery,
  fetchedAt: string,
): NormalizedFlightStatus | null {
  if (q.by !== 'flightNumber') return null;
  const flight = chooseFlight(raw, q);
  if (!flight) return null;

  const origin = airportCode(flight.departure.airport);
  const destination = airportCode(flight.arrival.airport);
  if (!origin || !destination) return null;

  const status = mapStatus(AERODATABOX_VOCAB, flight.status);
  const landed = status === 'landed';
  const active = status === 'active';
  const departureTime = flight.departure.runwayTime ?? flight.departure.revisedTime;
  const arrivalTime = flight.arrival.revisedTime ?? flight.arrival.runwayTime;

  return buildNormalized({
    flightNumber: compactFlightNumber(flight.number) ?? q.flightNumber,
    airlineIata: clean(flight.airline?.iata) ?? q.flightNumber.slice(0, 2).toUpperCase(),
    origin,
    destination,
    status,
    gate: clean(flight.arrival.gate) ?? clean(flight.departure.gate),
    terminal: clean(flight.arrival.terminal) ?? clean(flight.departure.terminal),
    baggageBelt: clean(flight.arrival.baggageBelt),
    scheduledDeparture: timeUtc(flight.departure.scheduledTime),
    estimatedDeparture: active || landed ? undefined : timeUtc(flight.departure.revisedTime),
    actualDeparture: active || landed ? timeUtc(departureTime) : undefined,
    scheduledArrival: timeUtc(flight.arrival.scheduledTime),
    estimatedArrival: landed
      ? undefined
      : (timeUtc(flight.arrival.revisedTime) ?? timeUtc(flight.arrival.predictedTime)),
    actualArrival: landed ? timeUtc(arrivalTime) : undefined,
    aircraftType: clean(flight.aircraft?.model),
    registration: clean(flight.aircraft?.reg),
    source: 'aerodatabox',
    fetchedAt,
    confidence: 0.82,
  });
}

export class AeroDataBoxProvider extends BaseProvider {
  readonly key = 'aerodatabox';
  readonly airlineIata = ['*'];
  readonly capabilities: ProviderCapabilities = {
    status: true,
    gate: true,
    baggage: true,
    schedule: true,
  };
  protected readonly cacheTtlMs = 5 * 60_000;

  protected async fetchRaw(q: FlightStatusQuery): Promise<unknown> {
    if (q.by !== 'flightNumber') return null;
    const cfg = aerodataboxConfig(this.ctx.config);
    const search = searchFor(q);
    const url = new URL(
      `${cfg.baseUrl.replace(/\/+$/, '')}/flights/${search.by}/${encodeURIComponent(search.param)}/${q.date}`,
    );
    url.searchParams.set('dateLocalRole', 'Both');
    url.searchParams.set('withAircraftImage', 'false');
    url.searchParams.set('withLocation', 'false');
    url.searchParams.set('withFlightPlan', 'false');

    return aerodataboxRawSchema.parse(
      await this.ctx.http.getJson(url.toString(), {
        headers: {
          ...authHeaders(cfg),
          'user-agent': USER_AGENT,
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
      }),
    );
  }

  protected normalize(raw: unknown, q: FlightStatusQuery): NormalizedFlightStatus | null {
    return normalizeAeroDataBox(raw as AeroDataBoxRaw, q, this.ctx.clock.nowIso());
  }
}

export function aerodataboxProviderFactory(): ProviderFactory {
  return { key: 'aerodatabox', airlineIata: ['*'], create: () => new AeroDataBoxProvider() };
}

function chooseFlight(raw: AeroDataBoxRaw, q: FlightStatusQuery): AeroDataBoxRaw[number] | null {
  if (raw.length === 0) return null;
  const callsign = q.by === 'flightNumber' ? clean(q.callsign)?.toUpperCase() : null;
  const flightNumber = q.by === 'flightNumber' ? compactFlightNumber(q.flightNumber) : null;
  const exactCallsign = callsign
    ? raw.find((flight) => clean(flight.callSign)?.toUpperCase() === callsign)
    : null;
  if (exactCallsign) return exactCallsign;
  const exactNumber = flightNumber
    ? raw.find((flight) => compactFlightNumber(flight.number) === flightNumber)
    : null;
  if (exactNumber) return exactNumber;
  // A callsign search can return stale legs for the same airframe. Never attach
  // the first unrelated result to the currently tracked callsign.
  if (callsign) return null;
  return raw.find((flight) => flight.codeshareStatus === 'IsOperator') ?? raw[0] ?? null;
}

function searchFor(q: Extract<FlightStatusQuery, { by: 'flightNumber' }>): {
  by: 'CallSign' | 'Icao24' | 'Number';
  param: string;
} {
  const callsign = clean(q.callsign);
  if (callsign) return { by: 'CallSign', param: callsign };
  const icao24 = clean(q.icao24);
  if (icao24) return { by: 'Icao24', param: icao24.toLowerCase() };
  return { by: 'Number', param: q.flightNumber };
}

function aerodataboxConfig(config: Record<string, unknown>): AeroDataBoxProviderConfig {
  const nested =
    config.aerodatabox && typeof config.aerodatabox === 'object'
      ? (config.aerodatabox as Record<string, unknown>)
      : {};
  const apiKey = stringValue(nested.apiKey) ?? stringValue(config.AERODATABOX_API_KEY);
  if (!apiKey) throw new Error('AERODATABOX_API_KEY is not configured');
  const marketplace = normalizeMarketplace(
    stringValue(nested.marketplace) ?? stringValue(config.AERODATABOX_MARKETPLACE),
  );
  const defaultBaseUrl = marketplace === 'rapidapi' ? RAPIDAPI_BASE_URL : APIMARKET_BASE_URL;
  return {
    apiKey,
    marketplace,
    baseUrl:
      stringValue(nested.baseUrl) ?? stringValue(config.AERODATABOX_BASE_URL) ?? defaultBaseUrl,
  };
}

function authHeaders(cfg: AeroDataBoxProviderConfig): Record<string, string> {
  if (cfg.marketplace === 'rapidapi') {
    return { 'X-RapidAPI-Key': cfg.apiKey, 'X-RapidAPI-Host': RAPIDAPI_HOST };
  }
  return { 'x-api-market-key': cfg.apiKey };
}

function normalizeMarketplace(value: string | undefined): 'apimarket' | 'rapidapi' {
  return value?.toLowerCase() === 'rapidapi' ? 'rapidapi' : 'apimarket';
}

function airportCode(airport: z.infer<typeof airportSchema>): string | null {
  return clean(airport.iata) ?? clean(airport.icao) ?? null;
}

function timeUtc(value: z.infer<typeof dateTimeSchema> | null | undefined): string | undefined {
  const raw = clean(value?.utc) ?? clean(value?.local);
  if (!raw) return undefined;
  return normalizeUtcLike(raw);
}

function clean(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactFlightNumber(value: string | null | undefined): string | undefined {
  return clean(value)?.replace(/\s+/g, '').toUpperCase();
}

function normalizeUtcLike(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?Z$/);
  if (!match) return value;
  return `${match[1]}T${match[2]}:${match[3] ?? '00'}Z`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
