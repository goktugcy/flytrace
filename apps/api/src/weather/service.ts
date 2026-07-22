import {
  type WeatherKind,
  type WeatherMapFeatureCollection,
  type WeatherPoint,
  type WeatherSeverity,
  errors,
} from '@flytrace/shared';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const CACHE_TTL_MS = 10 * 60 * 1000;
const SURFACE_FIELDS = [
  'temperature_2m',
  'weather_code',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'cloud_cover',
  'visibility',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'cape',
] as const;

const PRESSURE_LEVELS = [
  { hpa: 1000, altitudeFt: 360 },
  { hpa: 925, altitudeFt: 2_500 },
  { hpa: 850, altitudeFt: 5_000 },
  { hpa: 700, altitudeFt: 10_000 },
  { hpa: 600, altitudeFt: 14_000 },
  { hpa: 500, altitudeFt: 18_000 },
  { hpa: 400, altitudeFt: 24_000 },
  { hpa: 300, altitudeFt: 30_000 },
  { hpa: 250, altitudeFt: 34_000 },
  { hpa: 200, altitudeFt: 39_000 },
  { hpa: 150, altitudeFt: 45_000 },
] as const;

type Fetcher = typeof fetch;
type CurrentValues = Record<string, unknown> & { time?: unknown };

interface OpenMeteoResponse {
  latitude?: unknown;
  longitude?: unknown;
  current?: CurrentValues;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

export class WeatherService {
  private readonly cache = new Map<
    string,
    CacheEntry<WeatherPoint | WeatherMapFeatureCollection>
  >();

  constructor(
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async point(lat: number, lon: number, altitudeFt?: number): Promise<WeatherPoint> {
    const selected = altitudeFt == null ? null : nearestPressureLevel(altitudeFt);
    const key = `point:${lat.toFixed(2)}:${lon.toFixed(2)}:${selected?.hpa ?? 'surface'}`;
    const hit = this.readCache<WeatherPoint>(key);
    if (hit) return hit;

    const pressureFields = selected ? pressureFieldsFor(selected.index) : [];
    const payload = await this.request([lat], [lon], [...SURFACE_FIELDS, ...pressureFields]);
    const raw = Array.isArray(payload) ? payload[0] : payload;
    if (!raw?.current) throw errors.upstream('Open-Meteo returned no current weather');
    const data = weatherPointFromCurrent(raw, lat, lon, altitudeFt, selected?.index ?? null);
    this.writeCache(key, data);
    return data;
  }

  async viewport(
    bbox: readonly [number, number, number, number],
    zoom: number,
  ): Promise<WeatherMapFeatureCollection> {
    const samples = sampleViewport(bbox, zoom);
    const key = `viewport:${samples.map(([lon, lat]) => `${lon.toFixed(2)},${lat.toFixed(2)}`).join(';')}`;
    const hit = this.readCache<WeatherMapFeatureCollection>(key);
    if (hit) return hit;

    const payload = await this.request(
      samples.map((point) => point[1]),
      samples.map((point) => point[0]),
      [...SURFACE_FIELDS],
    );
    const records = Array.isArray(payload) ? payload : [payload];
    const points = records
      .map((record, index) => {
        const fallback = samples[index];
        if (!record?.current || !fallback) return null;
        return weatherPointFromCurrent(record, fallback[1], fallback[0]);
      })
      .filter((point): point is WeatherPoint => point !== null)
      .filter((point) => point.condition.kind !== 'clear');

    const generatedAt = new Date(this.now()).toISOString();
    const data: WeatherMapFeatureCollection = {
      type: 'FeatureCollection',
      count: points.length,
      sampleCount: samples.length,
      generatedAt,
      model: 'open-meteo',
      features: points.map((point, index) => {
        const id = `weather:${point.lat.toFixed(3)}:${point.lon.toFixed(3)}:${index}`;
        return {
          type: 'Feature',
          id,
          geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
          properties: {
            id,
            kind: point.condition.kind,
            severity: point.condition.severity,
            label: point.condition.label,
            code: point.condition.code,
            observedAt: point.observedAt,
            temperatureC: point.temperatureC,
            precipitationMm: point.precipitationMm,
            windKt: point.wind.speedKt,
            gustKt: point.wind.gustKt,
            capeJkg: point.convection.capeJkg,
          },
        };
      }),
    };
    this.writeCache(key, data);
    return data;
  }

  private async request(
    latitudes: number[],
    longitudes: number[],
    currentFields: string[],
  ): Promise<OpenMeteoResponse | OpenMeteoResponse[]> {
    const url = new URL(OPEN_METEO_URL);
    url.searchParams.set('latitude', latitudes.map(compactCoordinate).join(','));
    url.searchParams.set('longitude', longitudes.map(compactCoordinate).join(','));
    url.searchParams.set('current', [...new Set(currentFields)].join(','));
    url.searchParams.set('wind_speed_unit', 'kn');
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', 'GMT');

    try {
      const response = await this.fetcher(url, {
        headers: { accept: 'application/json', 'user-agent': 'FlyTrace/1.0' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        throw errors.upstream(`Open-Meteo request failed (${response.status})`);
      }
      return (await response.json()) as OpenMeteoResponse | OpenMeteoResponse[];
    } catch (error) {
      if (error instanceof Error && error.name === 'AppError') throw error;
      throw errors.upstream('Open-Meteo request failed', error);
    }
  }

  private readCache<T>(key: string): T | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    return hit.data as T;
  }

  private writeCache<T extends WeatherPoint | WeatherMapFeatureCollection>(key: string, data: T) {
    this.cache.set(key, { data, expiresAt: this.now() + CACHE_TTL_MS });
  }
}

function weatherPointFromCurrent(
  raw: OpenMeteoResponse,
  fallbackLat: number,
  fallbackLon: number,
  altitudeFt?: number,
  pressureIndex: number | null = null,
): WeatherPoint {
  const current = raw.current ?? {};
  const code = value(current, 'weather_code') ?? 0;
  const surface = classifyCondition({
    code,
    precipitationMm: value(current, 'precipitation'),
    snowfallCm: value(current, 'snowfall'),
    gustKt: value(current, 'wind_gusts_10m'),
    capeJkg: value(current, 'cape'),
    visibilityM: value(current, 'visibility'),
  });
  const altitude =
    altitudeFt != null && pressureIndex != null
      ? altitudeWeather(current, altitudeFt, pressureIndex)
      : null;
  const turbulence = estimateTurbulence({
    code,
    capeJkg: value(current, 'cape'),
    altitude,
  });

  return {
    lat: valueFromUnknown(raw.latitude) ?? fallbackLat,
    lon: valueFromUnknown(raw.longitude) ?? fallbackLon,
    observedAt:
      typeof current.time === 'string'
        ? `${current.time}${current.time.endsWith('Z') ? '' : 'Z'}`
        : new Date().toISOString(),
    model: 'open-meteo',
    condition: { code, ...surface },
    temperatureC: value(current, 'temperature_2m'),
    precipitationMm: value(current, 'precipitation'),
    rainMm: value(current, 'rain'),
    showersMm: value(current, 'showers'),
    snowfallCm: value(current, 'snowfall'),
    cloudCoverPct: value(current, 'cloud_cover'),
    visibilityM: value(current, 'visibility'),
    wind: {
      speedKt: value(current, 'wind_speed_10m'),
      directionDeg: value(current, 'wind_direction_10m'),
      gustKt: value(current, 'wind_gusts_10m'),
    },
    convection: { capeJkg: value(current, 'cape') },
    altitude,
    turbulence,
  };
}

function altitudeWeather(
  current: CurrentValues,
  requestedFt: number,
  pressureIndex: number,
): NonNullable<WeatherPoint['altitude']> {
  const level = PRESSURE_LEVELS[pressureIndex] ?? PRESSURE_LEVELS[0];
  const adjacentIndex = pressureIndex === 0 ? 1 : pressureIndex - 1;
  const adjacent = PRESSURE_LEVELS[adjacentIndex] ?? level;
  const speed = value(current, `wind_speed_${level.hpa}hPa`);
  const direction = value(current, `wind_direction_${level.hpa}hPa`);
  const adjacentSpeed = value(current, `wind_speed_${adjacent.hpa}hPa`);
  const adjacentDirection = value(current, `wind_direction_${adjacent.hpa}hPa`);

  return {
    requestedFt,
    pressureLevelHpa: level.hpa,
    windSpeedKt: speed,
    windDirectionDeg: direction,
    verticalVelocityMs: value(current, `vertical_velocity_${level.hpa}hPa`),
    windShearKt: vectorDifference(speed, direction, adjacentSpeed, adjacentDirection),
  };
}

export function estimateTurbulence(input: {
  code: number;
  capeJkg: number | null;
  altitude: WeatherPoint['altitude'];
}): WeatherPoint['turbulence'] {
  let score = 0;
  const reasons: string[] = [];
  const cape = input.capeJkg ?? 0;
  if (cape >= 2_500) {
    score += 55;
    reasons.push('Very strong convective potential');
  } else if (cape >= 1_500) {
    score += 42;
    reasons.push('Strong convective potential');
  } else if (cape >= 800) {
    score += 28;
    reasons.push('Elevated convective potential');
  } else if (cape >= 300) {
    score += 12;
    reasons.push('Some convective potential');
  }
  if (input.code >= 95) {
    score += input.code >= 96 ? 38 : 30;
    reasons.push('Thunderstorm conditions');
  }

  const shear = input.altitude?.windShearKt ?? 0;
  if (shear >= 40) {
    score += 38;
    reasons.push('Strong modelled wind shear near flight level');
  } else if (shear >= 25) {
    score += 26;
    reasons.push('Moderate modelled wind shear near flight level');
  } else if (shear >= 15) {
    score += 14;
    reasons.push('Light modelled wind shear near flight level');
  }

  const verticalVelocity = Math.abs(input.altitude?.verticalVelocityMs ?? 0);
  if (verticalVelocity >= 0.8) {
    score += 30;
    reasons.push('Strong vertical air motion in the forecast model');
  } else if (verticalVelocity >= 0.35) {
    score += 20;
    reasons.push('Moderate vertical air motion in the forecast model');
  } else if (verticalVelocity >= 0.15) {
    score += 10;
    reasons.push('Vertical air motion in the forecast model');
  }

  const flightLevelWind = input.altitude?.windSpeedKt ?? 0;
  if (flightLevelWind >= 120) {
    score += 18;
    reasons.push('Very strong wind near flight level');
  } else if (flightLevelWind >= 80) {
    score += 10;
    reasons.push('Strong wind near flight level');
  }

  const bounded = Math.min(100, Math.round(score));
  return {
    estimated: true,
    level: severityFromScore(bounded),
    score: bounded,
    reasons,
  };
}

export function classifyCondition(input: {
  code: number;
  precipitationMm: number | null;
  snowfallCm: number | null;
  gustKt: number | null;
  capeJkg: number | null;
  visibilityM: number | null;
}): { label: string; kind: WeatherKind; severity: WeatherSeverity } {
  const { code } = input;
  const cape = input.capeJkg ?? 0;
  if (code >= 95 || cape >= 800) {
    const severity: WeatherSeverity =
      code >= 99 || cape >= 2_500 ? 'severe' : code >= 96 || cape >= 1_500 ? 'high' : 'moderate';
    return {
      label: code >= 95 ? 'Thunderstorm' : 'Convective storm risk',
      kind: 'storm',
      severity,
    };
  }
  if ((input.snowfallCm ?? 0) > 0 || (code >= 71 && code <= 77) || (code >= 85 && code <= 86)) {
    return {
      label: code >= 85 ? 'Snow showers' : 'Snow',
      kind: 'snow',
      severity: (input.snowfallCm ?? 0) >= 2 ? 'high' : 'moderate',
    };
  }
  const precipitation = input.precipitationMm ?? 0;
  if (precipitation > 0.05 || (code >= 51 && code <= 67) || (code >= 80 && code <= 82)) {
    return {
      label: code >= 80 ? 'Rain showers' : code <= 57 ? 'Drizzle' : 'Rain',
      kind: 'rain',
      severity: precipitation >= 5 ? 'high' : precipitation >= 1 ? 'moderate' : 'low',
    };
  }
  const visibility = input.visibilityM ?? Number.POSITIVE_INFINITY;
  if (code === 45 || code === 48 || visibility < 3_000) {
    return {
      label: 'Low visibility / fog',
      kind: 'fog',
      severity: visibility < 1_000 ? 'high' : 'moderate',
    };
  }
  const gust = input.gustKt ?? 0;
  if (gust >= 25) {
    return {
      label: 'Strong wind',
      kind: 'wind',
      severity: gust >= 50 ? 'severe' : gust >= 40 ? 'high' : gust >= 30 ? 'moderate' : 'low',
    };
  }
  return { label: wmoLabel(code), kind: 'clear', severity: 'none' };
}

export function sampleViewport(
  [west, south, east, north]: readonly [number, number, number, number],
  zoom: number,
): [number, number][] {
  const columns = zoom < 2 ? 7 : zoom < 4 ? 6 : zoom < 7 ? 5 : 4;
  const rows = zoom < 4 ? 4 : 3;
  const longitudeSpan = east >= west ? east - west : east + 360 - west;
  const latitudeSpan = north - south;
  const points: [number, number][] = [];
  for (let row = 0; row < rows; row += 1) {
    const lat = Math.max(-85, Math.min(85, south + (latitudeSpan * (row + 0.5)) / rows));
    for (let column = 0; column < columns; column += 1) {
      const unwrapped = west + (longitudeSpan * (column + 0.5)) / columns;
      const lon = ((((unwrapped + 180) % 360) + 360) % 360) - 180;
      points.push([lon, lat]);
    }
  }
  return points;
}

function nearestPressureLevel(altitudeFt: number): { index: number; hpa: number } {
  let index = 0;
  let distance = Number.POSITIVE_INFINITY;
  PRESSURE_LEVELS.forEach((level, candidate) => {
    const next = Math.abs(level.altitudeFt - altitudeFt);
    if (next < distance) {
      distance = next;
      index = candidate;
    }
  });
  return { index, hpa: PRESSURE_LEVELS[index]?.hpa ?? 1000 };
}

function pressureFieldsFor(index: number): string[] {
  const selected = PRESSURE_LEVELS[index] ?? PRESSURE_LEVELS[0];
  const adjacent = PRESSURE_LEVELS[index === 0 ? 1 : index - 1] ?? selected;
  return [selected, adjacent].flatMap((level) => [
    `wind_speed_${level.hpa}hPa`,
    `wind_direction_${level.hpa}hPa`,
    `vertical_velocity_${level.hpa}hPa`,
  ]);
}

function vectorDifference(
  speedA: number | null,
  directionA: number | null,
  speedB: number | null,
  directionB: number | null,
): number | null {
  if (speedA == null || directionA == null || speedB == null || directionB == null) return null;
  const radians = Math.PI / 180;
  const uA = speedA * Math.sin(directionA * radians);
  const vA = speedA * Math.cos(directionA * radians);
  const uB = speedB * Math.sin(directionB * radians);
  const vB = speedB * Math.cos(directionB * radians);
  return Math.round(Math.hypot(uA - uB, vA - vB) * 10) / 10;
}

function severityFromScore(score: number): WeatherSeverity {
  if (score >= 80) return 'severe';
  if (score >= 60) return 'high';
  if (score >= 40) return 'moderate';
  if (score >= 20) return 'low';
  return 'none';
}

function wmoLabel(code: number): string {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 57) return 'Drizzle';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Showers';
  if (code <= 86) return 'Snow showers';
  return 'Thunderstorm';
}

function value(record: CurrentValues, key: string): number | null {
  return valueFromUnknown(record[key]);
}

function valueFromUnknown(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) ? input : null;
}

function compactCoordinate(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}
