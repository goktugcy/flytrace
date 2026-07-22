'use client';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/states';
import { apiBase } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { WeatherPoint, WeatherSeverity } from '@flytrace/shared';
import {
  AlertTriangle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Eye,
  Gauge,
  Info,
  Navigation,
  Thermometer,
  Wind,
} from 'lucide-react';
import { useEffect, useState } from 'react';

const API_BASE = apiBase();

interface FlightPosition {
  lat: number | null;
  lon: number | null;
  altitudeFt: number | null;
}

export function FlightWeatherPanel({ position }: { position: FlightPosition | null }) {
  const [weather, setWeather] = useState<WeatherPoint | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const weatherKey =
    position?.lat != null && position.lon != null
      ? `${position.lat.toFixed(2)}:${position.lon.toFixed(2)}:${Math.round((position.altitudeFt ?? 0) / 2_500)}`
      : '';

  // biome-ignore lint/correctness/useExhaustiveDependencies: weatherKey deliberately quantizes aircraft movement
  useEffect(() => {
    if (!position || position.lat == null || position.lon == null) {
      setWeather(null);
      setState('idle');
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams({
      lat: String(position.lat),
      lon: String(position.lon),
      ...(position.altitudeFt != null ? { alt: String(position.altitudeFt) } : {}),
    });
    setState('loading');
    fetch(`${API_BASE}/api/v1/weather/point?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`weather ${response.status}`);
        return (await response.json()) as { data: { weather: WeatherPoint } };
      })
      .then((body) => {
        setWeather(body.data.weather);
        setState('ready');
      })
      .catch((error) => {
        if ((error as Error).name !== 'AbortError') {
          setWeather(null);
          setState('error');
        }
      });
    return () => controller.abort();
  }, [weatherKey]);

  const ConditionIcon = weather ? conditionIcon(weather.condition.kind) : CloudSun;
  return (
    <Card className="lg:col-span-2">
      <CardHeader className="flex-row items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ConditionIcon
            className={cn(
              'size-4 text-muted-foreground',
              weather?.condition.kind === 'storm' && 'animate-pulse text-warning',
            )}
          />
          Weather near aircraft
        </CardTitle>
        {weather && (
          <div className="flex items-center gap-2">
            <Badge variant={severityBadge(weather.condition.severity)}>
              {weather.condition.label}
            </Badge>
            <span className="hidden text-xs text-muted-foreground sm:inline">Open-Meteo</span>
          </div>
        )}
      </CardHeader>
      <CardContent>
        {state === 'loading' && !weather && (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <Spinner /> Loading local weather model…
          </div>
        )}
        {state === 'error' && (
          <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
            <AlertTriangle className="size-4" /> Weather data is temporarily unavailable.
          </div>
        )}
        {state === 'idle' && (
          <div className="py-5 text-sm text-muted-foreground">
            Waiting for an aircraft position…
          </div>
        )}
        {weather && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <WeatherMetric
                icon={Thermometer}
                label="Temperature"
                value={weather.temperatureC != null ? `${Math.round(weather.temperatureC)}°C` : '—'}
              />
              <WeatherMetric
                icon={CloudRain}
                label="Precipitation"
                value={formatAmount(weather.precipitationMm, 'mm')}
              />
              <WeatherMetric
                icon={Wind}
                label="Surface wind"
                value={formatAmount(weather.wind.speedKt, 'kt')}
              />
              <WeatherMetric
                icon={Navigation}
                label="Wind gust"
                value={formatAmount(weather.wind.gustKt, 'kt')}
              />
              <WeatherMetric
                icon={Eye}
                label="Visibility"
                value={formatVisibility(weather.visibilityM)}
              />
              <WeatherMetric
                icon={CloudLightning}
                label="CAPE"
                value={formatAmount(weather.convection.capeJkg, 'J/kg')}
              />
            </div>

            <div className={cn('rounded-md border p-4', riskClasses(weather.turbulence.level))}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 font-medium">
                  <Gauge className="size-4" /> Estimated turbulence potential
                </div>
                <Badge variant={severityBadge(weather.turbulence.level)} className="capitalize">
                  {weather.turbulence.level} · {weather.turbulence.score}/100
                </Badge>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <SmallField
                  label="Flight-level wind"
                  value={formatAmount(weather.altitude?.windSpeedKt ?? null, 'kt')}
                />
                <SmallField
                  label="Modelled wind shear"
                  value={formatAmount(weather.altitude?.windShearKt ?? null, 'kt')}
                />
                <SmallField
                  label="Pressure level"
                  value={weather.altitude ? `${weather.altitude.pressureLevelHpa} hPa` : '—'}
                />
              </div>
              {weather.turbulence.reasons.length > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {weather.turbulence.reasons.join(' · ')}
                </p>
              )}
              <div className="mt-3 flex gap-2 border-t border-current/10 pt-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Model estimate from convection, vertical motion and nearby pressure-level wind
                  shear. It is not radar, PIREP or an operational turbulence report.
                </span>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WeatherMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Wind;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border bg-muted/25 p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 truncate text-base font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function SmallField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

function conditionIcon(kind: WeatherPoint['condition']['kind']) {
  if (kind === 'storm') return CloudLightning;
  if (kind === 'rain') return CloudRain;
  if (kind === 'wind') return Wind;
  if (kind === 'snow') return CloudSnow;
  if (kind === 'fog') return CloudFog;
  return CloudSun;
}

function severityBadge(
  severity: WeatherSeverity,
): 'success' | 'warning' | 'destructive' | 'outline' {
  if (severity === 'severe' || severity === 'high') return 'destructive';
  if (severity === 'moderate' || severity === 'low') return 'warning';
  return 'success';
}

function riskClasses(severity: WeatherSeverity): string {
  if (severity === 'severe' || severity === 'high') {
    return 'border-destructive/30 bg-destructive/5';
  }
  if (severity === 'moderate' || severity === 'low') return 'border-warning/30 bg-warning/5';
  return 'border-success/25 bg-success/5';
}

function formatAmount(value: number | null, unit: string): string {
  if (value == null) return '—';
  const digits = Math.abs(value) < 10 && value % 1 !== 0 ? 1 : 0;
  return `${value.toFixed(digits)} ${unit}`;
}

function formatVisibility(value: number | null): string {
  if (value == null) return '—';
  return value >= 1_000
    ? `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} km`
    : `${Math.round(value)} m`;
}
