import { describe, expect, test } from 'bun:test';
import {
  WeatherService,
  classifyCondition,
  estimateTurbulence,
  sampleViewport,
} from './service.ts';

describe('weather service', () => {
  test('classifies convective weather ahead of surface wind', () => {
    expect(
      classifyCondition({
        code: 95,
        precipitationMm: 3,
        snowfallCm: 0,
        gustKt: 42,
        capeJkg: 1_700,
        visibilityM: 8_000,
      }),
    ).toEqual({ label: 'Thunderstorm', kind: 'storm', severity: 'high' });
  });

  test('builds a bounded turbulence estimate from convection and flight-level shear', () => {
    const result = estimateTurbulence({
      code: 95,
      capeJkg: 2_000,
      altitude: {
        requestedFt: 34_000,
        pressureLevelHpa: 250,
        windSpeedKt: 110,
        windDirectionDeg: 270,
        verticalVelocityMs: 0.4,
        windShearKt: 28,
      },
    });
    expect(result.level).toBe('severe');
    expect(result.score).toBe(100);
    expect(result.reasons.length).toBeGreaterThan(2);
  });

  test('samples wrapped viewports without exceeding the coordinate limits', () => {
    const points = sampleViewport([170, -20, -170, 20], 3);
    expect(points).toHaveLength(24);
    expect(points.every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -85 && lat <= 85)).toBe(
      true,
    );
  });

  test('maps Open-Meteo point data and uses the nearest pressure level', async () => {
    let requested = '';
    const fetcher = (async (input: string | URL | Request) => {
      requested = String(input);
      return Response.json({
        latitude: 41,
        longitude: 29,
        current: {
          time: '2026-07-22T01:00',
          temperature_2m: 22,
          weather_code: 61,
          precipitation: 1.2,
          rain: 1.2,
          showers: 0,
          snowfall: 0,
          cloud_cover: 80,
          visibility: 7_000,
          wind_speed_10m: 12,
          wind_direction_10m: 210,
          wind_gusts_10m: 24,
          cape: 200,
          wind_speed_250hPa: 70,
          wind_direction_250hPa: 250,
          vertical_velocity_250hPa: 0.1,
          wind_speed_300hPa: 52,
          wind_direction_300hPa: 230,
          vertical_velocity_300hPa: 0.05,
        },
      });
    }) as typeof fetch;
    const service = new WeatherService(fetcher, () => Date.parse('2026-07-22T01:05:00Z'));
    const point = await service.point(41, 29, 34_000);
    expect(point.condition.kind).toBe('rain');
    expect(point.altitude?.pressureLevelHpa).toBe(250);
    expect(point.altitude?.windShearKt).toBeGreaterThan(0);
    expect(requested).toContain('wind_speed_250hPa');
  });
});
